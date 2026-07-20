/**
 * Admin Management Routes
 * Endpoints to list, grant, revoke admin privileges and send invite emails.
 * All routes require: authMiddleware + adminAuth (super-admin only).
 *
 * Security notes:
 *  - All inputs are validated and sanitised server-side.
 *  - Internal error details are never sent to the client in production.
 *  - Invite magic links are NOT stored in Firestore (only a hash is kept for audit).
 *  - Self-modification (grant/revoke own account) is blocked at every endpoint.
 *  - Rate limiting for invite endpoint to prevent link-spam.
 */

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// ── safe error helper ─────────────────────────────────────────────────────────
// Never leak internal messages to the client in production.
function safeError(res, status, publicMsg, internalError) {
  console.error(`[adminManagement] ${publicMsg}:`, internalError);
  return res.status(status).json({
    error: publicMsg,
    ...(IS_PROD ? {} : { details: internalError?.message }),
  });
}

// ── simple in-memory rate limiter for /invite ─────────────────────────────────
// Prevents an admin from spamming invite links. Max 5 invites per 10 minutes.
const inviteRateLimiter = new Map(); // uid → { count, resetAt }
const INVITE_WINDOW_MS = 10 * 60 * 1000;
const INVITE_MAX = 5;

function checkInviteRateLimit(uid) {
  const now = Date.now();
  const entry = inviteRateLimiter.get(uid);
  if (!entry || now > entry.resetAt) {
    inviteRateLimiter.set(uid, { count: 1, resetAt: now + INVITE_WINDOW_MS });
    return true;
  }
  if (entry.count >= INVITE_MAX) return false;
  entry.count++;
  return true;
}

// ── list all admin users ──────────────────────────────────────────────────────
async function listAdminUsers() {
  const admins = [];
  let pageToken;
  do {
    const result = await admin.auth().listUsers(1000, pageToken);
    for (const user of result.users) {
      if (user.customClaims?.admin === true) {
        admins.push({
          uid: user.uid,
          email: user.email || null,
          displayName: user.displayName || null,
          photoURL: user.photoURL || null,
          disabled: user.disabled,
          createdAt: user.metadata.creationTime,
          lastSignIn: user.metadata.lastSignInTime,
        });
      }
    }
    pageToken = result.pageToken;
  } while (pageToken);
  return admins;
}

// ── GET /admins ───────────────────────────────────────────────────────────────
router.get('/admins', async (req, res) => {
  try {
    const admins = await listAdminUsers();
    res.json({ success: true, admins });
  } catch (error) {
    safeError(res, 500, 'Failed to list admins', error);
  }
});

// ── POST /admins/grant ────────────────────────────────────────────────────────
router.post('/admins/grant', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    let target;
    try {
      target = await admin.auth().getUserByEmail(cleanEmail);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'No account found with that email. They must sign up first.' });
      }
      throw e;
    }

    // Block self-modification
    if (target.uid === req.user.uid) {
      return res.status(400).json({ error: 'You cannot modify your own admin status' });
    }

    // Idempotent: already an admin → just confirm
    if (target.customClaims?.admin === true) {
      return res.json({ success: true, message: `${cleanEmail} is already an admin` });
    }

    await admin.auth().setCustomUserClaims(target.uid, {
      ...(target.customClaims || {}),
      admin: true,
    });

    // Mirror role in Firestore for app-level isAdmin() checks
    const db = admin.firestore();
    await db.collection('users').doc(target.uid).set(
      {
        role: 'admin',
        adminGrantedBy: req.user.uid,
        adminGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Audit log
    await db.collection('admin_audit_log').add({
      action: 'grant_admin',
      targetUid: target.uid,
      targetEmail: cleanEmail,
      performedBy: req.user.uid,
      performedByEmail: req.user.email || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[adminManagement] ${req.user.email} granted admin to ${cleanEmail}`);
    res.json({ success: true, message: `Admin granted to ${cleanEmail}` });
  } catch (error) {
    safeError(res, 500, 'Failed to grant admin', error);
  }
});

// ── POST /admins/revoke ───────────────────────────────────────────────────────
router.post('/admins/revoke', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid || typeof uid !== 'string' || uid.length > 128) {
      return res.status(400).json({ error: 'Valid uid is required' });
    }

    // Block self-modification
    if (uid === req.user.uid) {
      return res.status(400).json({ error: 'You cannot revoke your own admin status' });
    }

    let target;
    try {
      target = await admin.auth().getUser(uid);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        return res.status(404).json({ error: 'User not found' });
      }
      throw e;
    }

    // Remove only the admin claim, preserve any other claims
    const claims = { ...(target.customClaims || {}) };
    delete claims.admin;
    await admin.auth().setCustomUserClaims(uid, Object.keys(claims).length ? claims : null);

    const db = admin.firestore();
    await db.collection('users').doc(uid).set(
      {
        role: admin.firestore.FieldValue.delete(),
        adminRevokedBy: req.user.uid,
        adminRevokedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Audit log
    await db.collection('admin_audit_log').add({
      action: 'revoke_admin',
      targetUid: uid,
      targetEmail: target.email || null,
      performedBy: req.user.uid,
      performedByEmail: req.user.email || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[adminManagement] ${req.user.email} revoked admin from uid:${uid}`);
    res.json({ success: true, message: 'Admin access revoked' });
  } catch (error) {
    safeError(res, 500, 'Failed to revoke admin', error);
  }
});

// ── POST /admins/invite ───────────────────────────────────────────────────────
router.post('/admins/invite', async (req, res) => {
  try {
    // Rate limit per calling admin
    if (!checkInviteRateLimit(req.user.uid)) {
      return res.status(429).json({
        error: `Too many invites. Maximum ${INVITE_MAX} invites per 10 minutes.`,
      });
    }

    const { email } = req.body;
    if (!email || typeof email !== 'string' || email.length > 254) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Don't invite someone who is already an admin
    try {
      const existing = await admin.auth().getUserByEmail(cleanEmail);
      if (existing.customClaims?.admin === true) {
        return res.status(400).json({ error: `${cleanEmail} is already an admin` });
      }
    } catch (e) {
      // auth/user-not-found is fine — they don't have an account yet
      if (e.code !== 'auth/user-not-found') throw e;
    }

    const adminWebUrl = (process.env.ADMIN_WEB_URL || 'https://admin.saigonmatch.com.vn').replace(/\/$/, '');
    const actionCodeSettings = {
      url: `${adminWebUrl}/login?invited=1`,
      handleCodeInApp: true,
    };

    const link = await admin.auth().generateSignInWithEmailLink(cleanEmail, actionCodeSettings);

    // Store ONLY a hash of the link for audit — never the raw token
    const linkHash = crypto.createHash('sha256').update(link).digest('hex');

    const db = admin.firestore();
    await db.collection('admin_invites').add({
      email: cleanEmail,
      invitedBy: req.user.uid,
      invitedByEmail: req.user.email || null,
      invitedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      linkHash, // audit only — cannot reconstruct the link from this
    });

    // Audit log
    await db.collection('admin_audit_log').add({
      action: 'invite_sent',
      targetEmail: cleanEmail,
      performedBy: req.user.uid,
      performedByEmail: req.user.email || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[adminManagement] ${req.user.email} generated invite for ${cleanEmail}`);

    res.json({
      success: true,
      message: `Invite link generated for ${cleanEmail}`,
      link,
      note: 'Send this link to the recipient. It expires in 1 hour. After they sign in, use Grant Admin to assign privileges.',
    });
  } catch (error) {
    safeError(res, 500, 'Failed to generate invite', error);
  }
});

module.exports = router;

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();

function createIdempotencyMiddleware(options = {}) {
  const ttlMs = Number(options.ttlMs || process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
  const lockMs = Number(options.lockMs || process.env.IDEMPOTENCY_LOCK_MS || 60 * 1000);
  const requireKey = String(process.env.REQUIRE_IDEMPOTENCY_KEY || '').toLowerCase() === 'true';

  return async function idempotencyMiddleware(req, res, next) {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();

    const key = req.headers['x-idempotency-key'];
    if (!key) {
      if (requireKey) {
        return res.status(400).json({ success: false, error: 'Missing x-idempotency-key' });
      }
      return next();
    }

    const uid = req.user?.uid || 'anonymous';
    const route = `${req.baseUrl}${req.path}`;
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${uid}|${route}|${String(key)}`)
      .digest('hex');
    const ref = db.collection('idempotency_keys').doc(fingerprint);
    const now = Date.now();

    try {
      const existing = await ref.get();
      if (existing.exists) {
        const data = existing.data() || {};
        const createdAtMs = data.createdAt?.toMillis?.() || 0;
        const age = now - createdAtMs;

        if (data.status === 'completed' && age <= ttlMs) {
          return res.status(data.statusCode || 200).json(data.responseBody || { success: true });
        }

        if (data.status === 'in_progress' && age <= lockMs) {
          return res.status(409).json({ success: false, error: 'Duplicate request in progress' });
        }
      }

      await ref.set({
        uid,
        route,
        status: 'in_progress',
        createdAt: Timestamp.now(),
      }, { merge: true });

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const statusCode = res.statusCode || 200;
        if (statusCode < 500) {
          ref.set({
            uid,
            route,
            status: 'completed',
            statusCode,
            responseBody: body,
            createdAt: Timestamp.now(),
          }, { merge: true }).catch((err) => {
            console.error('[IDEMPOTENCY] Failed to persist response:', err);
          });
        } else {
          ref.set({
            uid,
            route,
            status: 'failed',
            statusCode,
            createdAt: Timestamp.now(),
          }, { merge: true }).catch(() => {});
        }
        return originalJson(body);
      };

      next();
    } catch (error) {
      console.error('[IDEMPOTENCY] Middleware error:', error);
      return res.status(500).json({ success: false, error: 'Idempotency middleware failed' });
    }
  };
}

module.exports = { createIdempotencyMiddleware };

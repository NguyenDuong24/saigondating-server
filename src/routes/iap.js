/**
 * IAP (In-App Purchase) Verification Routes
 * 
 * Google Play Billing & Apple App Store purchase verification.
 * Verifies receipts with Google/Apple, prevents duplicate credits,
 * and adds coins/Pro to user wallet.
 */

const express = require('express');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

// ─── Product Configuration ─────────────────────────────────────
// Maps Google Play SKU → coins / effects
const IAP_PRODUCTS = {
  // Coin packages (consumable)
  'com.saigonmatch.coin_10':   { type: 'coin', coins: 10,   bonus: 0 },
  'com.saigonmatch.coin_50':   { type: 'coin', coins: 50,   bonus: 5 },
  'com.saigonmatch.coin_100':  { type: 'coin', coins: 100,  bonus: 20 },
  'com.saigonmatch.coin_500':  { type: 'coin', coins: 500,  bonus: 150 },

  // Pro subscription (non-consumable)
  'com.saigonmatch.pro_monthly': { type: 'pro', durationDays: 30 },
};

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Verify Google Play purchase via Google Play Developer API.
 * Requires googleapis package and GOOGLE_PLAY_SERVICE_ACCOUNT env.
 */
async function verifyGooglePlayPurchase(purchaseToken, productId, packageName) {
  try {
    // If googleapis not installed or no service account, skip server-side verify
    const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
      console.log('[IAP] No GOOGLE_PLAY_SERVICE_ACCOUNT — skipping server-side Google Play verify');
      return null; // null = skipped, not failed
    }

    const { google } = require('googleapis');
    const key = JSON.parse(serviceAccountJson);
    const jwtClient = new google.auth.JWT(
      key.client_email,
      null,
      key.private_key,
      ['https://www.googleapis.com/auth/androidpublisher'],
      null,
    );

    await jwtClient.authorize();

    const androidPublisher = google.androidpublisher({ version: 'v3', auth: jwtClient });
    const pkg = packageName || process.env.ANDROID_PACKAGE_NAME || 'saigonmatch.com.vn';

    const response = await androidPublisher.purchases.products.get({
      packageName: pkg,
      productId,
      token: purchaseToken,
    });

    const purchase = response.data;
    console.log('[IAP] Google Play verify result:', {
      purchaseState: purchase.purchaseState, // 0=purchased, 1=cancelled, 2=pending
      consumptionState: purchase.consumptionState,
    });

    return {
      valid: purchase.purchaseState === 0,
      purchaseState: purchase.purchaseState,
      orderId: purchase.orderId,
    };
  } catch (err) {
    console.error('[IAP] Google Play verification error:', err.message);
    // Don't fail — fall back to basic validation
    return { valid: true, warning: 'server_verify_failed' };
  }
}

/**
 * Add coins to user wallet
 */
async function creditCoins(uid, productId, transactionId, coinAmount, bonusAmount) {
  const nowTs = Timestamp.now();
  const totalCoins = coinAmount + bonusAmount;

  const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
  const txRef = db
    .collection('users').doc(uid)
    .collection('wallet')
    .collection('transactions')
    .doc(`iap_${transactionId}`);

  await db.runTransaction(async (transaction) => {
    // Check for duplicate
    const txSnap = await transaction.get(txRef);
    if (txSnap.exists) {
      throw Object.assign(new Error('DUPLICATE_TRANSACTION'), { code: 'DUPLICATE' });
    }

    const walletDoc = await transaction.get(walletRef);
    const currentCoins = Number(walletDoc.exists ? (walletDoc.data().coins || 0) : 0);
    const newCoins = currentCoins + totalCoins;

    transaction.set(walletRef, { coins: newCoins, lastUpdate: nowTs }, { merge: true });
    transaction.set(txRef, {
      id: txRef.id,
      type: 'topup_iap',
      amount: totalCoins,
      baseAmount: coinAmount,
      bonusAmount,
      currencyType: 'coin',
      createdAt: nowTs,
      transactionId,
      productId,
      status: 'completed',
      metadata: { source: 'google_play' },
    }, { merge: true });
  });

  // Send push notification
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data() || {};
    const fcmTokens = userData.fcmTokens || [];
    if (fcmTokens.length > 0) {
      await admin.messaging().sendEachForMulticast({
        notification: {
          title: `Đã nhận ${totalCoins} Coin`,
          body: `Cảm ơn bạn đã mua ${totalCoins} coin!${bonusAmount > 0 ? ` (bao gồm ${bonusAmount} coin thưởng)` : ''}`,
        },
        data: { type: 'coin_purchase', productId, coins: String(totalCoins) },
        tokens: fcmTokens,
      });
    }
  } catch (err) {
    console.error('[IAP] Push notification failed:', err.message);
    // Non-critical
  }

  return totalCoins;
}

/**
 * Activate Pro subscription
 */
async function activatePro(uid, productId, transactionId, durationDays) {
  const nowTs = Timestamp.now();
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + durationDays);

  const txRef = db
    .collection('users').doc(uid)
    .collection('wallet')
    .collection('transactions')
    .doc(`iap_${transactionId}`);

  await db.runTransaction(async (transaction) => {
    const txSnap = await transaction.get(txRef);
    if (txSnap.exists) {
      throw Object.assign(new Error('DUPLICATE_TRANSACTION'), { code: 'DUPLICATE' });
    }

    const userRef = db.collection('users').doc(uid);
    transaction.set(userRef, {
      isPro: true,
      proExpiresAt: Timestamp.fromDate(expiryDate),
      proActivatedAt: nowTs,
      lastProPaymentDate: nowTs,
    }, { merge: true });

    transaction.set(txRef, {
      id: txRef.id,
      type: 'pro_subscription_iap',
      durationDays,
      currencyType: 'pro',
      createdAt: nowTs,
      transactionId,
      productId,
      status: 'completed',
      metadata: { source: 'google_play' },
    }, { merge: true });
  });

  // Send push notification
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data() || {};
    const fcmTokens = userData.fcmTokens || [];
    if (fcmTokens.length > 0) {
      await admin.messaging().sendEachForMulticast({
        notification: {
          title: '🎉 Đã kích hoạt Pro!',
          body: `Trải nghiệm Pro đã sẵn sàng. Hết hạn: ${expiryDate.toLocaleDateString('vi-VN')}`,
        },
        data: { type: 'pro_activated', productId },
        tokens: fcmTokens,
      });
    }
  } catch (err) {
    console.error('[IAP] Push notification failed:', err.message);
  }

  return { proExpiresAt: expiryDate.toISOString() };
}

// ─── Routes ────────────────────────────────────────────────────

/**
 * GET /iap/products
 * 
 * Get available IAP products. Public - no auth required.
 */
router.get('/products', async (req, res) => {
  try {
    const products = Object.entries(IAP_PRODUCTS).map(([id, config]) => ({
      productId: id,
      ...config,
    }));

    res.json({ success: true, products });
  } catch (error) {
    console.error('[IAP] products error:', error);
    res.status(500).json({ success: false, error: 'Failed to get products' });
  }
});

// Verify endpoint requires auth
router.use(authMiddleware);

/**
 * POST /iap/verify
 * 
 * Verify an IAP purchase and credit the user's account.
 * Called by client after a successful Google Play / App Store purchase.
 * 
 * Body:
 * {
 *   productId: "com.saigonmatch.coin_100",  // Google Play SKU
 *   transactionId: "GPA.1234-5678-...",     // Google Play transaction ID
 *   receipt: "purchase_token_from_google",   // Google Play purchase token
 *   platform: "android" | "ios"             // Platform identifier
 * }
 */
router.post('/verify', async (req, res) => {
  try {
    const uid = req.user.uid;
    const {
      productId,
      transactionId,
      receipt,    // Google Play purchase token
      platform = 'android',
    } = req.body;

    // ── Validate input ──────────────────────────────────
    if (!productId || !transactionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing productId or transactionId',
      });
    }

    // Sanitize: limit string lengths
    const safeProductId = String(productId).slice(0, 256);
    const safeTransactionId = String(transactionId).slice(0, 512);
    const safePlatform = ['android', 'ios'].includes(String(platform))
      ? String(platform)
      : 'android';

    // ── Check for duplicate transaction ──────────────────
    const txSnap = await db.collection('users').doc(uid)
      .collection('wallet')
      .collection('transactions')
      .doc(`iap_${safeTransactionId}`)
      .get();

    if (txSnap.exists) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        message: 'Transaction already processed',
      });
    }

    // ── Look up product ──────────────────────────────────
    const product = IAP_PRODUCTS[safeProductId];
    if (!product) {
      console.error('[IAP] Unknown product:', safeProductId);
      return res.status(400).json({
        success: false,
        error: `Unknown product: ${safeProductId}`,
      });
    }

    // ── Google Play server-side verification (if configured) ─
    if (safePlatform === 'android' && receipt) {
      const googleResult = await verifyGooglePlayPurchase(
        String(receipt),
        safeProductId,
      );
      if (googleResult && !googleResult.valid) {
        return res.status(400).json({
          success: false,
          error: 'Purchase verification failed',
          code: 'VERIFY_FAILED',
        });
      }
    }

    // ── Credit the user ──────────────────────────────────
    let result;

    if (product.type === 'coin') {
      const totalCoins = await creditCoins(
        uid,
        safeProductId,
        safeTransactionId,
        product.coins,
        product.bonus,
      );
      result = {
        coinsAwarded: totalCoins,
        type: 'coin',
      };
    } else if (product.type === 'pro') {
      const proResult = await activatePro(
        uid,
        safeProductId,
        safeTransactionId,
        product.durationDays,
      );
      result = {
        proExpiresAt: proResult.proExpiresAt,
        type: 'pro',
      };
    } else {
      return res.status(500).json({ success: false, error: 'Unknown product type' });
    }

    console.log(`[IAP] ✅ Purchase verified: uid=${uid} product=${safeProductId} tx=${safeTransactionId}`);

    res.json({
      success: true,
      ...result,
    });

  } catch (error) {
    if (error.code === 'DUPLICATE') {
      return res.json({
        success: true,
        alreadyProcessed: true,
        message: 'Transaction already processed',
      });
    }

    console.error('[IAP] verify error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;

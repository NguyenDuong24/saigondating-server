/**
 * VietQR Payment Routes
 * Xá»­ lÃ½ thanh toÃ¡n VietQR cho náº¡p coin vÃ  nÃ¢ng cáº¥p Pro
 * Há»— trá»£ Webhook + Auto Polling Ä‘á»ƒ tá»± Ä‘á»™ng verify thanh toÃ¡n
 */

const express = require('express');
const crypto = require('crypto');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const authMiddleware = require('../middleware/auth');
const { createIdempotencyMiddleware } = require('../middleware/idempotency');

const router = express.Router();
const db = getFirestore();
const idempotency = createIdempotencyMiddleware();

// Track polling intervals
const pollingIntervals = new Map();

// ==============================================================
// VietQR Configuration
// ==============================================================
const VIETQR_CONFIG = {
  bankCode: 970436, // Vietcombank
  accountNumber: process.env.VIETQR_ACCOUNT || '',
  accountName: process.env.VIETQR_ACCOUNT_NAME || '',
  template: process.env.VIETQR_TEMPLATE || 'compact', // or 'compact2'
};

const DEFAULT_COIN_PACKAGES = [
  { id: 'coin_10', coins: 10, price: 1000 },
  { id: 'coin_50', coins: 50, price: 2000 },
  { id: 'coin_100', coins: 100, price: 3000 },
  { id: 'coin_500', coins: 500, price: 5000 },
];

function getServerCoinPackages() {
  try {
    if (process.env.VIETQR_COIN_PACKAGES) {
      const parsed = JSON.parse(process.env.VIETQR_COIN_PACKAGES);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('[VIETQR] Invalid VIETQR_COIN_PACKAGES env, using defaults');
  }
  return DEFAULT_COIN_PACKAGES;
}

function getPackageById(packageId) {
  if (!packageId) return null;
  return getServerCoinPackages().find((p) => p && p.id === packageId) || null;
}

function isValidOrderId(orderId) {
  return typeof orderId === 'string' && /^ORD[A-Z0-9]{4,40}$/i.test(orderId);
}

function isValidPaymentDescription(description) {
  return typeof description === 'string' && /^(VIP|PRO)_ORD[A-Z0-9]{4,40}$/i.test(description);
}

// ==============================================================
// Helper Functions
// ==============================================================

/**
 * Verify webhook signature from banking provider
 */
function verifyWebhookSignature(payload, signature) {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[VIETQR] WEBHOOK_SECRET not configured');
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');

  return expectedSignature === signature;
}

/**
 * Send push notification to user
 */
async function sendPushNotification(uid, { title, body, data }) {
  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.warn('[VIETQR] User not found for notification:', uid);
      return;
    }

    // Get user's FCM token (if available)
    const userData = userDoc.data();
    if (!userData.fcmTokens || userData.fcmTokens.length === 0) {
      console.log('[VIETQR] No FCM tokens for user:', uid);
      return;
    }

    // Send multicast message
    const message = {
      notification: { title, body },
      data: data || {},
      tokens: userData.fcmTokens,
    };

    const response = await admin.messaging().sendMulticast(message);
    console.log('[VIETQR] Push notifications sent:', response.successCount);
  } catch (error) {
    console.error('[VIETQR] Error sending notification:', error);
  }
}

/**
 * Complete a payment order and add coins/pro to user
 */
async function completePaymentOrder(orderId, order, options = {}) {
  try {
    const orderRef = db.collection('users').doc(order.uid).collection('orders').doc(orderId);
    const nowTs = Timestamp.now();
    const verificationMethod = options.method || 'webhook';
    const verificationDescription = options.description || null;
    let result = { success: true, orderId, status: 'completed', alreadyProcessed: false };

    await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw { status: 404, message: 'Order not found' };
      }

      const orderData = orderSnap.data() || {};
      if (orderData.status === 'completed') {
        result = { success: true, orderId, status: 'completed', alreadyProcessed: true };
        return;
      }
      if (orderData.status !== 'pending') {
        throw { status: 409, message: `Order is ${orderData.status}` };
      }

      if (orderData.product === 'coin') {
        const coinAmount = Number(orderData?.coinPackage?.amount || 0);
        if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
          throw { status: 400, message: 'Invalid coin package in order' };
        }
        const walletRef = db.collection('users').doc(order.uid).collection('wallet').doc('balance');
        const txRef = db.collection('users').doc(order.uid).collection('wallet').collection('transactions').doc(`vietqr_${orderId}`);
        const walletSnap = await transaction.get(walletRef);
        const currentCoins = Number(walletSnap.exists ? (walletSnap.data().coins || 0) : 0);
        const newCoins = currentCoins + coinAmount;

        transaction.set(walletRef, { coins: newCoins, lastUpdate: nowTs }, { merge: true });
        transaction.set(txRef, {
          id: txRef.id,
          type: 'topup_vietqr',
          amount: coinAmount,
          price: orderData.amount,
          currencyType: 'coin',
          createdAt: nowTs,
          orderId: orderId,
          status: 'completed',
          metadata: {
            source: `vietqr_${verificationMethod}`,
            autoVerified: verificationMethod !== 'manual',
          },
        }, { merge: true });

        result.coinsAdded = coinAmount;
        result.newBalance = newCoins;
      } else if (orderData.product === 'pro_upgrade') {
        const userRef = db.collection('users').doc(order.uid);
        const proExpiry = new Date();
        proExpiry.setMonth(proExpiry.getMonth() + 1);
        transaction.set(userRef, {
          isPro: true,
          proExpiresAt: Timestamp.fromDate(proExpiry),
          proActivatedAt: nowTs,
          lastProPaymentDate: nowTs,
        }, { merge: true });
        result.proStatus = 'activated';
        result.proExpiresAt = proExpiry.toISOString();
      } else {
        throw { status: 400, message: 'Invalid order product type' };
      }

      transaction.update(orderRef, {
        status: 'completed',
        completedAt: nowTs,
        autoVerified: verificationMethod !== 'manual',
        verificationMethod,
        verificationDescription,
        processedTxnIds: FieldValue.arrayUnion(`ORDER_${orderId}`),
      });
    });

    if (!result.alreadyProcessed) {
      console.log('[VIETQR] Order completed:', orderId);
      if (result.coinsAdded) {
        await sendPushNotification(order.uid, {
          title: 'Payment completed',
          body: `You received ${result.coinsAdded} coins`,
          data: { orderId, coins: result.coinsAdded },
        });
      } else if (result.proStatus === 'activated') {
        await sendPushNotification(order.uid, {
          title: 'Pro upgrade completed',
          body: 'Your Pro plan is now active',
          data: { orderId, proExpiresAt: result.proExpiresAt },
        });
      }
    }

    return result;
  } catch (error) {
    console.error('[VIETQR] Error completing payment order:', error);
    throw error;
  }
}

/**
 * Generate unique order ID based on timestamp and random
 */
function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `ORD${timestamp}${random}`;
}

/**
 * Create VietQR payload string
 * EMV QRCPS format
 * 
 * Includes:
 * - Bank code (Vietcombank: 970436)
 * - Account number
 * - Amount (optional, can be left for user to fill)
 * - Description: FORMAT_AMOUNT_ORDERID (e.g., VIP_PRO_1000_ORD1234567890)
 * - Account name
 * 
 * Returns QR string that can be encoded to QR image
 */
function createVietQRString(amount, productType, orderId) {
  // Format: PRODUCTTYPE_PRODUCTID_ORDERID
  // Example: VIP_PRO_ORD123456 (product type + orderid)
  const description = `${productType}_${orderId}`;

  // For VietQR compact format (EMV QRCPS-MPM)
  // This is a simplified format that works with most banking apps
  // Format: https://img.vietqr.io/image/{BANKCODE}-{ACCOUNT}-{AMOUNT}-{DESCRIPTION}-compact2.png?addInfo={DESCRIPTION}&accountName={NAME}

  // We return the QR data format that can be used with vietqr.io API or local QR generation
  const qrData = {
    bankCode: VIETQR_CONFIG.bankCode,
    accountNumber: VIETQR_CONFIG.accountNumber,
    accountName: VIETQR_CONFIG.accountName,
    amount: amount,
    description: description,
    // URLs for different QR generation methods
    // compact2 is the recommended format - auto-fills amount AND description in ALL major banking apps
    qrUrl: `https://img.vietqr.io/image/${VIETQR_CONFIG.bankCode}-${VIETQR_CONFIG.accountNumber}-${amount}-${encodeURIComponent(description)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(VIETQR_CONFIG.accountName)}`,
    // Raw string for library-based QR generation
    qrString: `00020801021131300012970436010213${VIETQR_CONFIG.accountNumber}52040000530370454061${String(amount).padStart(15, '0')}080${description}9999996304`,
  };

  return qrData;
}

/**
 * Verify payment by checking transaction description
 * Server receives the description that was used for payment
 * and verifies it matches expected format
 */
async function verifyPaymentDescription(uid, description, orderId) {
  try {
    // Parse description format: PRODUCTTYPE_ORDERID
    // Example: VIP_PRO_ORD123456
    const parts = description.split('_');

    if (parts.length < 2) {
      throw { status: 400, message: 'Invalid payment description format' };
    }

    const [productType, ...orderParts] = parts;
    const extractedOrderId = orderParts.join('_');

    // Verify order ID matches
    if (extractedOrderId !== orderId) {
      console.warn('[VIETQR] Order ID mismatch:', { extractedOrderId, orderId });
      throw { status: 400, message: 'Payment description does not match order' };
    }

    // Check if order exists and belongs to user
    const ordersRef = db.collection('users').doc(uid).collection('orders');
    const orderQuery = await ordersRef
      .where('orderId', '==', orderId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (orderQuery.empty) {
      console.warn('[VIETQR] Order not found or not pending:', { orderId, uid });
      throw { status: 404, message: 'Order not found or already completed' };
    }

    const orderDoc = orderQuery.docs[0];
    const orderData = orderDoc.data();

    return {
      orderId,
      productType,
      amount: orderData.amount,
      product: orderData.product,
    };
  } catch (error) {
    console.error('[VIETQR] Error verifying description:', error);
    throw error;
  }
}

// ==============================================================
// VIETQR ROUTES
// ==============================================================

/**
 * POST /vietqr/create-payment
 * Create VietQR payment for coin purchase or pro upgrade
 * 
 * Body:
 * {
 *   "product": "coin" | "pro_upgrade",
 *   "coinPackage": { "amount": 1000, "price": 99000 }, // for coin purchase
 *   "productType": "VIP" | "PRO" // for metadata
 * }
 */
router.post('/create-payment', authMiddleware, idempotency, async (req, res) => {
  try {
    const uid = req.user.uid;
    console.log('[VIETQR] Creating payment for uid:', uid);

    const { product, coinPackage, productType = 'VIP' } = req.body;
    const normalizedProductType = String(productType || 'VIP').toUpperCase();
    if (!VIETQR_CONFIG.accountNumber || !VIETQR_CONFIG.accountName) {
      throw { status: 500, message: 'VietQR account configuration missing' };
    }

    let amount, description, orderData;

    if (product === 'coin' && coinPackage) {
      // Coin purchase
      const packageId = String(coinPackage.id || '').trim();
      const serverPackage = getPackageById(packageId);
      if (!serverPackage) {
        throw { status: 400, message: 'Invalid coin package' };
      }
      amount = Number(serverPackage.price);
      const orderId = generateOrderId();
      const transactionCode = `VQR_${Date.now()}_${uid.substring(0, 8)}`;
      const expiresAt = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);

      orderData = {
        uid,
        orderId,
        product: 'coin',
        coinPackage: {
          id: serverPackage.id,
          amount: Number(serverPackage.coins),
          price: Number(serverPackage.price),
        },
        productType: normalizedProductType === 'PRO' ? 'PRO' : 'VIP',
        amount,
        status: 'pending',
        createdAt: Timestamp.now(),
        description: `${normalizedProductType === 'PRO' ? 'PRO' : 'VIP'}_${orderId}`,
        transactionCode,
        expiresAt,
        processedTxnIds: [],
        attemptCount: 0,
      };

      description = orderData.description;
    } else if (product === 'pro_upgrade') {
      // Pro upgrade (assumes fixed price)
      amount = Number(process.env.PRO_UPGRADE_PRICE || 99000);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw { status: 500, message: 'Invalid PRO_UPGRADE_PRICE configuration' };
      }
      const orderId = generateOrderId();
      const transactionCode = `VQR_${Date.now()}_${uid.substring(0, 8)}`;
      const expiresAt = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);

      orderData = {
        uid,
        orderId,
        product: 'pro_upgrade',
        productType: 'PRO',
        amount,
        status: 'pending',
        createdAt: Timestamp.now(),
        description: `PRO_${orderId}`,
        transactionCode,
        expiresAt,
        processedTxnIds: [],
        attemptCount: 0,
      };

      description = orderData.description;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid product type',
      });
    }

    // Save order to database with 'pending' status
    const ordersRef = db.collection('users').doc(uid).collection('orders');
    await ordersRef.doc(orderData.orderId).set(orderData);

    console.log('[VIETQR] Order created:', orderData.orderId);

    // Generate VietQR string
    const qrData = createVietQRString(amount, orderData.productType, orderData.orderId);

    res.json({
      success: true,
      orderId: orderData.orderId,
      amount,
      description,
      currency: 'VND',
      bankCode: VIETQR_CONFIG.bankCode,
      accountNumber: VIETQR_CONFIG.accountNumber,
      accountName: VIETQR_CONFIG.accountName,
      // QR image URL from vietqr.io service
      qrImageUrl: qrData.qrUrl,
      // Raw QR string for generating QR code locally
      qrString: qrData.qrString,
      // Instructions for user
      instructions: {
        method1: 'DÃ¹ng á»©ng dá»¥ng ngÃ¢n hÃ ng Ä‘á»ƒ quÃ©t mÃ£ QR bÃªn dÆ°á»›i',
        method2: `Hoáº·c chuyá»ƒn khoáº£n thá»§ cÃ´ng: ${VIETQR_CONFIG.accountNumber} (${VIETQR_CONFIG.accountName}), ná»™i dung: ${description}`,
      },
    });
  } catch (error) {
    console.error('[VIETQR] create-payment error:', error);
    const status = error.status || 500;
    const message = error.message || 'Failed to create payment';
    res.status(status).json({ success: false, error: message });
  }
});

/**
 * POST /vietqr/verify-payment
 * Verify that user has completed the payment
 * 
 * Body:
 * {
 *   "orderId": "ORD123456",
 *   "description": "VIP_ORD123456", // the reference description used in bank transfer
 *   "amount": 99000
 * }
 */
router.post('/verify-payment', authMiddleware, idempotency, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { orderId, description, amount } = req.body;

    console.log('[VIETQR] Verifying payment:', { uid, orderId, description, amount });

    if (!orderId || !description) {
      return res.status(400).json({
        success: false,
        error: 'Missing orderId or description',
      });
    }
    if (!isValidOrderId(String(orderId)) || !isValidPaymentDescription(String(description))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid orderId or description format',
      });
    }

    // Verify the description format and order exists
    const orderInfo = await verifyPaymentDescription(uid, description, orderId);

    // Check amount matches
    if (amount !== undefined && Number(amount) !== Number(orderInfo.amount)) {
      console.warn('[VIETQR] Amount mismatch:', { expected: orderInfo.amount, received: amount });
      return res.status(400).json({
        success: false,
        error: 'Amount does not match order',
      });
    }

    // Get order document
    const orderRef = db.collection('users').doc(uid).collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    const orderData = orderDoc.data();
    const result = await completePaymentOrder(
      orderId,
      { uid, ...orderData },
      { method: 'manual', description }
    );
    result.message = result.alreadyProcessed ? 'Payment already processed' : 'Payment verified successfully';

    console.log('[VIETQR] Payment verified and processed:', result);
    res.json(result);
  } catch (error) {
    console.error('[VIETQR] verify-payment error:', error);
    const status = error.status || 500;
    const message = error.message || 'Failed to verify payment';
    res.status(status).json({ success: false, error: message });
  }
});

/**
 * GET /vietqr/order-status/:orderId
 * Check the status of an order
 */
router.get('/order-status/:orderId', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { orderId } = req.params;
    if (!isValidOrderId(String(orderId))) {
      return res.status(400).json({ success: false, error: 'Invalid orderId' });
    }

    const orderRef = db.collection('users').doc(uid).collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    const orderData = orderDoc.data();

    // Check if order has expired
    const now = Math.floor(Date.now() / 1000);
    if (orderData.expiresAt && now > orderData.expiresAt) {
      // Mark as expired if not already
      if (orderData.status === 'pending') {
        await orderRef.update({
          status: 'expired',
          verificationMethod: 'timeout',
        });
      }
      return res.json({
        success: true,
        orderId,
        status: 'expired',
        product: orderData.product,
        amount: orderData.amount,
        message: 'Order expired (10 min timeout)',
      });
    }

    res.json({
      success: true,
      orderId,
      status: orderData.status,
      product: orderData.product,
      amount: orderData.amount,
      createdAt: orderData.createdAt?.toDate?.() || orderData.createdAt,
      completedAt: orderData.completedAt?.toDate?.() || orderData.completedAt,
      expiresAt: orderData.expiresAt,
      verificationMethod: orderData.verificationMethod || null,
    });
  } catch (error) {
    console.error('[VIETQR] order-status error:', error);
    const status = error.status || 500;
    const message = error.message || 'Failed to get order status';
    res.status(status).json({ success: false, error: message });
  }
});

/**
 * POST /vietqr/webhook/banking
 * Webhook tá»« ngÃ¢n hÃ ng nháº­n thÃ´ng bÃ¡o chuyá»ƒn khoáº£n
 * 
 * Body:
 * {
 *   "amount": 50000,           // VND
 *   "content": "VIP_ORD123456", // payment description
 *   "senderAccount": "0123456789", // tÃ i khoáº£n ngÆ°á»i gá»­i
 *   "timestamp": 1234567890    // ngÃ¢n hÃ ng timestamp
 * }
 */
router.post('/webhook/banking', async (req, res) => {
  try {
    // ðŸ›¡ï¸ Verify webhook signature
    const signature = req.headers['x-webhook-signature'];
    if (!signature || !verifyWebhookSignature(req.body, signature)) {
      console.warn('[VIETQR] Missing or invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const { amount, content, senderAccount, timestamp } = req.body;
    const parsedAmount = Number(amount);
    const parsedTimestamp = Number(timestamp);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (!Number.isFinite(parsedTimestamp)) {
      return res.status(400).json({ success: false, message: 'Missing timestamp' });
    }
    const nowMs = Date.now();
    const eventTsMs = parsedTimestamp > 10_000_000_000 ? parsedTimestamp : parsedTimestamp * 1000;
    if (Math.abs(nowMs - eventTsMs) > 10 * 60 * 1000) {
      return res.status(401).json({ success: false, message: 'Stale webhook event' });
    }

    const rawEventKey = `${content}|${parsedAmount}|${parsedTimestamp}|${senderAccount || ''}`;
    const webhookEventId = crypto.createHash('sha256').update(rawEventKey).digest('hex');
    const webhookEventRef = db.collection('vietqr_webhook_events').doc(webhookEventId);
    try {
      await webhookEventRef.create({ createdAt: Timestamp.now(), content, amount: parsedAmount, timestamp: parsedTimestamp });
    } catch (e) {
      console.log('[VIETQR] Duplicate webhook ignored:', webhookEventId);
      return res.status(200).json({ success: true, message: 'Duplicate webhook ignored' });
    }

    console.log('[VIETQR] ðŸ”” Webhook received:', { amount, content, senderAccount });

    if (!parsedAmount || !content) {
      return res.status(400).json({ success: false, message: 'Missing amount or content' });
    }

    // ðŸ” Parse payment content: VIP_ORD123456 or PRO_ORD123456
    const match = content.match(/^(VIP|PRO)_(.+)$/);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Invalid content format' });
    }

    const [, productType, orderId] = match;

    // ðŸ” Find order in database
    const ordersQuery = await db.collectionGroup('orders')
      .where('orderId', '==', orderId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (ordersQuery.empty) {
      console.warn('[VIETQR] Order not found or not pending:', orderId);
      // Still return 200 to avoid banking provider retry
      return res.status(200).json({ success: false, message: 'Order not found or already completed' });
    }

    const orderDoc = ordersQuery.docs[0];
    const order = orderDoc.data();
    const uid = orderDoc.ref.parent.parent.id; // Get uid from path users/{uid}/orders

    // âœ… Verify amount matches
    if (Number(order.amount) !== parsedAmount) {
      console.warn('[VIETQR] Amount mismatch:', { expected: order.amount, received: amount });
      return res.status(200).json({ success: false, message: 'Amount mismatch' });
    }

    // âœ… Verify product type matches
    if (order.productType !== productType) {
      console.warn('[VIETQR] Product type mismatch:', { expected: order.productType, received: productType });
      return res.status(200).json({ success: false, message: 'Product type mismatch' });
    }

    // ðŸ’° Complete the order
    await completePaymentOrder(orderId, { uid, ...order }, { method: 'webhook', description: content });

    console.log('[VIETQR] âœ… Payment auto-verified via webhook:', orderId);
    res.status(200).json({ success: true, message: 'Payment verified and processed' });

  } catch (error) {
    console.error('[VIETQR] webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==============================================================
// SECURITY INFRASTRUCTURE
// ==============================================================
const smsRateLimiter = new Map();
const SMS_RATE_LIMIT = 10;
const SMS_RATE_WINDOW = 60 * 1000;

function checkSmsRateLimit(key) {
  const now = Date.now();
  const entry = smsRateLimiter.get(key);
  if (!entry || now > entry.resetAt) {
    smsRateLimiter.set(key, { count: 1, resetAt: now + SMS_RATE_WINDOW });
    return true;
  }
  if (entry.count >= SMS_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

const processedNonces = new Set();
setInterval(() => processedNonces.clear(), 15 * 60 * 1000); // 15 min memory cache

async function checkAndStoreNonce(nonce, deviceId) {
  if (!nonce) return true;
  if (processedNonces.has(nonce)) return false;

  const nonceRef = db.collection('security_nonces').doc(nonce);
  const nonceDoc = await nonceRef.get();
  if (nonceDoc.exists) {
    processedNonces.add(nonce);
    return false;
  }

  await nonceRef.set({
    deviceId: deviceId || 'unknown',
    createdAt: Timestamp.now(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h retention
  });

  processedNonces.add(nonce);
  return true;
}

function getAuthorizedDeviceKeys() {
  const keys = process.env.DEVICE_API_KEYS || process.env.SMS_DEVICE_API_KEY || '';
  if (!keys) return null;
  return keys.split(',').map(k => k.trim()).filter(Boolean);
}

/**
 * POST /vietqr/sms-received
 * Secure SMS-based payment verification with multi-layer security:
 * - Device API Key authentication (X-Device-Key header)
 * - HMAC-SHA256 signature verification
 * - Timestamp freshness check (reject > 5min old)
 * - Nonce-based replay protection
 * - Rate limiting (10 req/min/device)
 * - OrderID-only matching (no amount-only fallback)
 * - Full security audit logging
 * - Idempotency checks
 */
router.post('/sms-received', async (req, res) => {
  try {
    const { smsContent, timestamp, signature, deviceId, nonce } = req.body;
    const deviceApiKey = req.headers['x-device-key'] || req.body.deviceApiKey;
    const requestIp = req.ip || req.connection?.remoteAddress || 'unknown';

    console.log('[VIETQR SMS] ðŸ“¥ Request from device:', deviceId, '| IP:', requestIp);

    // ============================================================
    // 1. Validate input
    // ============================================================
    if (!smsContent || !timestamp || !signature) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // ============================================================
    // 2. SECURITY: Device API Key authentication
    // ============================================================
    const authorizedKeys = getAuthorizedDeviceKeys();
    if (authorizedKeys && authorizedKeys.length > 0) {
      if (!deviceApiKey || !authorizedKeys.includes(deviceApiKey)) {
        console.error('[SECURITY] ðŸš« Invalid Device API Key from:', requestIp);
        try {
          await db.collection('security_logs').add({
            type: 'unauthorized_device', deviceId: deviceId || 'unknown',
            ip: requestIp, timestamp: Timestamp.now(),
          });
        } catch (e) { }
        return res.status(403).json({ success: false, message: 'Unauthorized device' });
      }
      console.log('[SECURITY] âœ… Device API Key verified');
    }

    // ============================================================
    // 3. SECURITY: Rate limiting (10 req/min per device)
    // ============================================================
    if (!checkSmsRateLimit(deviceId || requestIp)) {
      console.warn('[SECURITY] ðŸš« Rate limit exceeded:', deviceId);
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }

    // ============================================================
    // 4. SECURITY: Timestamp freshness (reject > 5 min old)
    // ============================================================
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - timestamp);
    if (timeDiff > 5 * 60) {
      console.error('[SECURITY] â° Timestamp too old:', timeDiff + 's drift');
      return res.status(400).json({ success: false, message: 'Request expired' });
    }

    // ============================================================
    // 5. SECURITY: Nonce replay protection (Persistent)
    // ============================================================
    if (nonce) {
      const isNonceValid = await checkAndStoreNonce(nonce, deviceId);
      if (!isNonceValid) {
        console.error('[SECURITY] ðŸ”„ Replay attack! Nonce reused:', nonce);
        return res.status(400).json({ success: false, message: 'Duplicate request detected' });
      }
    }

    // ============================================================
    // 6. Verify HMAC-SHA256 signature
    // ============================================================
    const smsReaderSecret = process.env.SMS_READER_SECRET;
    if (!smsReaderSecret) {
      return res.status(500).json({ success: false, message: 'Server config error' });
    }

    const data = `${smsContent}|${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', smsReaderSecret)
      .update(data)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('[SECURITY] âŒ Signature mismatch - forgery attempt');
      try {
        await db.collection('security_logs').add({
          type: 'signature_mismatch', deviceId: deviceId || 'unknown',
          ip: requestIp, timestamp: Timestamp.now(),
        });
      } catch (e) { }
      return res.status(401).json({ success: false, message: 'Signature failed' });
    }

    console.log('[VIETQR SMS] âœ… All security checks passed');

    // ============================================================
    // 3. Parse SMS content
    // ============================================================
    const parsedSms = parseSmsContent(smsContent);
    if (!parsedSms) {
      console.error('[VIETQR SMS] Could not parse SMS:', smsContent.substring(0, 50));
      return res.status(400).json({
        success: false,
        message: 'Could not parse SMS content or no recognizable patterns found'
      });
    }

    console.log('[VIETQR SMS] ðŸ“ Parsed SMS:', {
      amount: parsedSms.amount,
      account: parsedSms.account,
      memo: parsedSms.memo
    });

    // ============================================================
    // 8. SECURITY: Require memo/orderId - no amount-only matching
    //    Amount-only is dangerous: two orders with same amount
    //    could be swapped by an attacker.
    // ============================================================
    if (!parsedSms.memo) {
      console.warn('[SECURITY] âš ï¸ No order ID in SMS - rejecting for safety');
      return res.status(400).json({
        success: false,
        message: 'No order ID (ORDxxx) found in notification. Cannot verify securely.'
      });
    }

    // ============================================================
    // 9. Find matching pending order (orderId-based only)
    // ============================================================
    let pendingOrders;

    // Strategy 1: Search by orderId field
    console.log('[VIETQR SMS] ðŸ” Searching by orderId:', parsedSms.memo);
    try {
      pendingOrders = await db.collectionGroup('orders')
        .where('orderId', '==', parsedSms.memo)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
    } catch (indexErr) {
      console.warn('[VIETQR SMS] âš ï¸ orderId index query failed');
    }

    // Strategy 2: Search by description with VIP_ prefix
    if (!pendingOrders || pendingOrders.empty) {
      try {
        pendingOrders = await db.collectionGroup('orders')
          .where('description', '==', `VIP_${parsedSms.memo}`)
          .where('status', '==', 'pending')
          .limit(1)
          .get();
      } catch (indexErr) { }
    }

    // Strategy 3: Search by description with PRO_ prefix
    if (!pendingOrders || pendingOrders.empty) {
      try {
        pendingOrders = await db.collectionGroup('orders')
          .where('description', '==', `PRO_${parsedSms.memo}`)
          .where('status', '==', 'pending')
          .limit(1)
          .get();
      } catch (indexErr) { }
    }

    if (!pendingOrders || pendingOrders.empty) {
      console.warn('[VIETQR SMS] âš ï¸ No pending order found for amount:', parsedSms.amount, 'memo:', parsedSms.memo);
      return res.status(404).json({
        success: false,
        message: 'No matching pending order found. Please check amount and message content.'
      });
    }

    const orderDoc = pendingOrders.docs[0];
    const orderId = orderDoc.id;
    const orderData = orderDoc.data();
    const uid = orderDoc.ref.parent.parent.id;

    console.log('[VIETQR SMS] ðŸŽ¯ Found matching order:', {
      orderId,
      amount: orderData.amount,
      uid: uid.substring(0, 8) + '...'
    });

    // ============================================================
    // 5. Verify amount exactly matches
    // ============================================================
    if (parsedSms.amount !== orderData.amount) {
      console.error('[VIETQR SMS] Amount mismatch:', {
        sms: parsedSms.amount,
        order: orderData.amount
      });
      return res.status(400).json({
        success: false,
        message: 'Amount mismatch'
      });
    }

    // ============================================================
    // 6. Check if order already completed (avoid duplicates)
    // ============================================================
    if (orderData.status === 'completed') {
      console.log('[VIETQR SMS] âš ï¸ Order already completed (idempotent):', orderId);
      return res.json({
        success: true,
        orderId,
        amount: parsedSms.amount,
        message: 'Order already completed (idempotent)',
        alreadyProcessed: true
      });
    }

    // ============================================================
    // 7. Check idempotency - has this SMS already been processed?
    // ============================================================
    const smsCode = crypto
      .createHash('sha256')
      .update(smsContent)
      .digest('hex')
      .substring(0, 16);

    const processedSmsCodes = orderData.processedSmsCodes || [];
    if (processedSmsCodes.includes(smsCode)) {
      console.log('[VIETQR SMS] âš ï¸ SMS already processed (idempotent):', smsCode);
      return res.json({
        success: true,
        orderId,
        amount: parsedSms.amount,
        message: 'SMS already processed (idempotent)',
        alreadyProcessed: true
      });
    }

    // ============================================================
    // 8. Update order status to completed
    // ============================================================
    // SECURITY: Check order expiration
    if (orderData.expiresAt && now > orderData.expiresAt) {
      console.warn('[VIETQR SMS] â° Order expired:', orderId);
      return res.status(400).json({ success: false, message: 'Order expired' });
    }

    const orderRef = db.collection('users').doc(uid).collection('orders').doc(orderId);

    await orderRef.update({
      status: 'completed',
      verificationMethod: 'sms_banking',
      verifiedAt: Timestamp.now(),
      smsCode: smsCode,
      processedSmsCodes: admin.firestore.FieldValue.arrayUnion(smsCode),
      smsContent: smsContent.substring(0, 100),
      verifiedBy: {
        deviceId: deviceId || 'unknown',
        ip: requestIp,
        timestamp: now,
      }
    });

    console.log('[VIETQR SMS] âœ… Order status updated to completed');

    // ============================================================
    // 9. Credit coins to user wallet (idempotent)
    // ============================================================
    let coinsAdded = 0;

    if (orderData.product === 'coin') {
      const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');

      await db.runTransaction(async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const currentCoins = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;
        const newCoins = currentCoins + orderData.coinPackage.amount;

        transaction.update(walletRef, {
          coins: newCoins,
          lastUpdate: Timestamp.now()
        });

        // Create transaction record
        const txnRef = db.collection('users').doc(uid)
          .collection('wallet')
          .collection('transactions')
          .doc();

        transaction.set(txnRef, {
          id: txnRef.id,
          type: 'topup_vietqr',
          amount: orderData.coinPackage.amount,
          price: orderData.amount,
          currencyType: 'coin',
          createdAt: Timestamp.now(),
          orderId: orderId,
          status: 'completed',
          verificationMethod: 'sms_banking',
          smsCode: smsCode,
          metadata: {
            source: 'sms_banking',
            deviceId: deviceId,
            smsTimestamp: timestamp
          }
        });

        coinsAdded = orderData.coinPackage.amount;
      });

      console.log('[VIETQR SMS] ðŸ’° Coins credited:', coinsAdded);

      // Send notification to user
      try {
        await sendNotification(
          uid,
          'âœ… Náº¡p xu thÃ nh cÃ´ng!',
          `Báº¡n vá»«a náº¡p ${coinsAdded} xu tá»« thanh toÃ¡n VietQR`
        );
      } catch (notifError) {
        console.error('[VIETQR SMS] Notification failed:', notifError);
        // Don't fail the whole request if notification fails
      }
    }

    // ============================================================
    // 10. Return success response
    // ============================================================
    console.log('[VIETQR SMS] ðŸŽ‰ Payment verified successfully!');

    return res.json({
      success: true,
      orderId,
      amount: parsedSms.amount,
      coins: coinsAdded,
      message: 'Payment verified via SMS Banking',
      verificationMethod: 'sms_banking',
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('[VIETQR SMS] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error processing SMS',
      error: error.message
    });
  }
});

/**
 * Helper: Parse Vietcombank SMS content
 * Extracts amount, account, and memo from SMS text
 */
function parseSmsContent(message) {
  try {
    console.log('[SMS Parse] Raw message:', message.substring(0, 200));

    // ðŸ’° Pattern 1: Amount
    // Matches: "2,000VND", "+2.000Ä‘", "so tien 50000d", "GD: +50,000 VND", "2000 VND", "2.000"
    let amount = 0;
    const amountPatterns = [
      /([\d][\d\.,]{3,})\s*(?:VND|vnd|Ä‘|d)/i,      // 2,000VND or 2000 Ä‘
      /(?:\+|CD\s*|so\s*tien\s*|GD[:\s]*\+?)([\d][\d\.,]{3,})/i, // +2.000 or so tien 2.000
      /([\d][\d\.,]{3,})(?:\s*[dÄ‘v]|\s*$)/i,       // 2.000d or just 2.000 at end
    ];
    for (const pattern of amountPatterns) {
      const match = message.match(pattern);
      if (match) {
        amount = parseInt(match[1].replace(/[\.,]/g, ''), 10);
        if (amount >= 1000) break; // Most VCB payments are >= 1000
      }
    }

    // ðŸ“ Pattern 2: Order ID / Memo
    // Extract just the ORDxxx part (without VIP_ or PRO_ prefix)
    let memo = null;
    const memoPatterns = [
      /(?:VIP|PRO)[-_](ORD[A-Z0-9]{5,})/i,       // VIP-ORDxxx or VIP_ORDxxx
      /(ORD[A-Z0-9]{5,})/i,                      // ORDxxx directly
      /(?:ND|noi\s*dung|noidung)[:\s-]*.*?(ORD[A-Z0-9]{5,})/i, // ND: ... ORDxxx
      /([A-Z0-9]{5,})(?:\s*$|\s+)/i,             // Fallback to any uppercase code if it's the only one
    ];

    for (const pattern of memoPatterns) {
      const match = message.match(pattern);
      if (match) {
        memo = match[1].toUpperCase();
        break;
      }
    }

    // ðŸ¦ Pattern 3: Account
    const accountMatch = message.match(/TK\s*([*\d]+)/i);
    const account = accountMatch ? accountMatch[1] : 'unknown';

    console.log('[SMS Parse] Result:', { amount, account, memo });

    // We need at least one useful piece of data
    if ((amount && amount > 0) || memo) {
      return { amount, account, memo };
    }

    return null;
  } catch (error) {
    console.error('[SMS Parse Error]', error);
    return null;
  }
}

/**
 * POST /vietqr/check-pending
 * Cron endpoint - Check all pending orders má»—i 30 giÃ¢y
 * Gá»i tá»« external cron service hoáº·c scheduled task
 */
router.post('/check-pending', async (req, res) => {
  try {
    // ðŸ›¡ï¸ Verify cron secret
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    console.log('[VIETQR] ðŸ• Checking pending orders...');

    // ðŸ” Find all pending orders (filter by time on client to avoid index)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const allPendingOrders = await db.collectionGroup('orders')
      .where('status', '==', 'pending')
      .get();

    // Filter by createdAt on client (temporary workaround)
    const pendingOrders = {
      docs: allPendingOrders.docs.filter(doc => {
        const orderTime = doc.data().createdAt?.toDate?.() || new Date(0);
        return orderTime > fifteenMinutesAgo;
      }),
      size: 0
    };
    pendingOrders.size = pendingOrders.docs.length;

    console.log('[VIETQR] Found pending orders:', pendingOrders.size);

    let verifiedCount = 0;
    let errors = [];

    // Process each pending order
    for (const doc of pendingOrders.docs) {
      try {
        const order = doc.data();
        const uid = doc.ref.parent.parent.id;

        // ðŸ”„ Try to verify via banking API (if available)
        // This is placeholder - integrate with actual banking API
        if (process.env.BANKING_API_ENABLED === 'true') {
          const verified = await checkPaymentStatusViaAPI(order);
          if (verified) {
            await completePaymentOrder(doc.id, { uid, ...order });
            verifiedCount++;
          }
        }
      } catch (error) {
        console.error('[VIETQR] Error checking order:', error);
        errors.push({ orderId: doc.id, error: error.message });
      }
    }

    // âœ… CLEANUP: Delete expired orders from Firestore
    console.log('[VIETQR] ðŸ—‘ï¸ Cleaning up expired orders...');
    const now = Math.floor(Date.now() / 1000);
    const expiredOrders = await db.collectionGroup('orders')
      .where('expiresAt', '<', now)
      .get();

    let cleanedUpCount = 0;
    for (const doc of expiredOrders.docs) {
      try {
        const order = doc.data();
        // Only delete if order is in pending or expired status
        if (order.status === 'pending' || order.status === 'expired') {
          await doc.ref.delete();
          cleanedUpCount++;
          console.log('[VIETQR] ðŸ—‘ï¸ Deleted expired order:', doc.id);
        }
      } catch (error) {
        console.error('[VIETQR] Error deleting expired order:', error);
      }
    }

    console.log(`[VIETQR] Cleanup complete - deleted ${cleanedUpCount} expired orders`);

    res.json({
      success: true,
      message: `Checked ${pendingOrders.size} pending orders`,
      verified: verifiedCount,
      cleanedUp: cleanedUpCount,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    console.error('[VIETQR] check-pending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Check payment status via banking API
 * This is a template - implement with actual banking API
 */
async function checkPaymentStatusViaAPI(order) {
  try {
    // TODO: Implement with actual banking API
    // Example: VietQR API, Vietcombank API, etc.

    // Placeholder - return false (not verified via API)
    return false;
  } catch (error) {
    console.error('[VIETQR] Error checking payment via API:', error);
    return false;
  }
}

// ==============================================================
// Initialize Polling Service
// ==============================================================

/**
 * Start auto-polling for pending orders (runs every 30 seconds)
 */
function startPollingService() {
  if (pollingIntervals.has('pending-orders')) {
    console.log('[VIETQR] Polling service already running');
    return;
  }

  const interval = setInterval(async () => {
    try {
      // Find pending orders
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const pendingOrders = await db.collectionGroup('orders')
        .where('status', '==', 'pending')
        .where('createdAt', '>', Timestamp.fromDate(fifteenMinutesAgo))
        .limit(10) // Limit to avoid too many reads
        .get();

      if (pendingOrders.size > 0) {
        console.log('[VIETQR] ðŸ”„ Auto-polling', pendingOrders.size, 'pending orders');
      }

      // Check each order (webhook may have failed)
      for (const doc of pendingOrders.docs) {
        const order = doc.data();
        // Orders in Database, webhook will update when received
        // This is just a safety check
      }
    } catch (error) {
      console.error('[VIETQR] Polling error:', error);
    }
  }, 30 * 1000); // 30 seconds

  pollingIntervals.set('pending-orders', interval);
  console.log('[VIETQR] âœ… Polling service started');
}

// Start polling when module loads
startPollingService();

/**
 * POST /vietqr/report-issue
 * Report an issue with payment (manual report)
 */
router.post('/report-issue', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { orderId, issueType, message, amount, description } = req.body;
    if (orderId && !isValidOrderId(String(orderId))) {
      return res.status(400).json({ success: false, error: 'Invalid orderId' });
    }
    const safeIssueType = String(issueType || 'payment_not_received').slice(0, 64);
    const safeMessage = String(message || '').slice(0, 1000);
    const safeDescription = String(description || '').slice(0, 200);
    const safeAmount = Number(amount || 0);

    console.log('[VIETQR] Issue reported:', { uid, orderId, issueType });

    const reportRef = db.collection('payment_reports').doc();
    await reportRef.set({
      id: reportRef.id,
      uid,
      orderId: orderId || 'N/A',
      issueType: safeIssueType,
      message: safeMessage,
      amount: Number.isFinite(safeAmount) ? safeAmount : 0,
      description: safeDescription,
      status: 'pending',
      createdAt: Timestamp.now(),
    });

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('[VIETQR] report-issue error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit report' });
  }
});

module.exports = router;

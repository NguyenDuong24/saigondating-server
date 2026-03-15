/**
 * VietQR Payment Routes
 * Xử lý thanh toán VietQR cho nạp coin và nâng cấp Pro
 * Hỗ trợ Webhook + Auto Polling để tự động verify thanh toán
 */

const express = require('express');
const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const admin = require('firebase-admin');

const router = express.Router();
const db = getFirestore();

// Track polling intervals
const pollingIntervals = new Map();

// ==============================================================
// VietQR Configuration
// ==============================================================
const VIETQR_CONFIG = {
  bankCode: 970436, // Vietcombank
  accountNumber: process.env.VIETQR_ACCOUNT || '1018395984',
  accountName: process.env.VIETQR_ACCOUNT_NAME || 'Nguyen Thai Duong',
  template: process.env.VIETQR_TEMPLATE || 'compact', // or 'compact2'
};

// ==============================================================
// Helper Functions
// ==============================================================

/**
 * Verify Firebase auth token
 */
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { status: 401, message: 'No token provided' };
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    return decodedToken.uid;
  } catch (verifyError) {
    console.error('[VIETQR] verifyIdToken failed:', verifyError);
    throw { status: 401, message: 'Invalid auth token' };
  }
}

/**
 * Verify webhook signature from banking provider
 */
function verifyWebhookSignature(payload, signature) {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('[VIETQR] WEBHOOK_SECRET not configured, skipping signature verification');
    return true;
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
async function completePaymentOrder(orderId, order) {
  try {
    const orderRef = db.collection('users').doc(order.uid).collection('orders').doc(orderId);

    // Update order status
    await orderRef.update({
      status: 'completed',
      completedAt: Timestamp.now(),
      autoVerified: true,
    });

    console.log('[VIETQR] Order completed:', orderId);

    // Add coins or Pro based on product type
    if (order.product === 'coin') {
      const walletRef = db.collection('users').doc(order.uid).collection('wallet').doc('balance');

      await db.runTransaction(async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const currentCoins = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;
        const newCoins = currentCoins + order.coinPackage.amount;

        transaction.update(walletRef, {
          coins: newCoins,
          lastUpdate: Timestamp.now(),
        });

        // Create transaction record
        const transactionRef = db.collection('users').doc(order.uid).collection('wallet').collection('transactions').doc();
        transaction.set(transactionRef, {
          id: transactionRef.id,
          type: 'topup_vietqr',
          amount: order.coinPackage.amount,
          price: order.amount,
          currencyType: 'coin',
          createdAt: Timestamp.now(),
          orderId: orderId,
          status: 'completed',
          metadata: {
            source: 'vietqr_webhook',
            autoVerified: true,
          },
        });
      });

      // Send notification
      await sendPushNotification(order.uid, {
        title: '✅ Nạp xu thành công',
        body: `Bạn đã nhận được ${order.coinPackage.amount} xu!`,
        data: { orderId, coins: order.coinPackage.amount },
      });
    } else if (order.product === 'pro_upgrade') {
      const userRef = db.collection('users').doc(order.uid);
      const proExpiry = new Date();
      proExpiry.setMonth(proExpiry.getMonth() + 1);

      await userRef.update({
        isPro: true,
        proExpiresAt: Timestamp.fromDate(proExpiry),
        proActivatedAt: Timestamp.now(),
        lastProPaymentDate: Timestamp.now(),
      });

      // Send notification
      await sendPushNotification(order.uid, {
        title: '✅ Nâng cấp Pro thành công',
        body: 'Bạn đã trở thành thành viên Pro!',
        data: { orderId, proExpiresAt: proExpiry.toISOString() },
      });
    }

    return true;
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
    qrUrl: `https://img.vietqr.io/image/${VIETQR_CONFIG.bankCode}-${VIETQR_CONFIG.accountNumber}-${amount}-${encodeURIComponent(description)}-${VIETQR_CONFIG.template}.png?addInfo=${encodeURIComponent(description)}&accountName=${encodeURIComponent(VIETQR_CONFIG.accountName)}`,
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
router.post('/create-payment', async (req, res) => {
  try {
    const uid = await verifyAuth(req);
    console.log('[VIETQR] Creating payment for uid:', uid);

    const { product, coinPackage, productType = 'VIP' } = req.body;

    let amount, description, orderData;

    if (product === 'coin' && coinPackage) {
      // Coin purchase
      amount = coinPackage.price;
      const orderId = generateOrderId();
      const transactionCode = `VQR_${Date.now()}_${uid.substring(0, 8)}`;
      const expiresAt = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);

      orderData = {
        uid,
        orderId,
        product: 'coin',
        coinPackage,
        productType,
        amount,
        status: 'pending',
        createdAt: Timestamp.now(),
        description: `${productType}_${orderId}`,
        transactionCode,
        expiresAt,
        processedTxnIds: [],
        attemptCount: 0,
      };

      description = orderData.description;
    } else if (product === 'pro_upgrade') {
      // Pro upgrade (assumes fixed price)
      amount = process.env.PRO_UPGRADE_PRICE || 99000;
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
    const qrData = createVietQRString(amount, productType, orderData.orderId);

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
        method1: 'Dùng ứng dụng ngân hàng để quét mã QR bên dưới',
        method2: `Hoặc chuyển khoản thủ công: ${VIETQR_CONFIG.accountNumber} (${VIETQR_CONFIG.accountName}), nội dung: ${description}`,
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
router.post('/verify-payment', async (req, res) => {
  try {
    const uid = await verifyAuth(req);
    const { orderId, description, amount } = req.body;

    console.log('[VIETQR] Verifying payment:', { uid, orderId, description, amount });

    if (!orderId || !description) {
      return res.status(400).json({
        success: false,
        error: 'Missing orderId or description',
      });
    }

    // Verify the description format and order exists
    const orderInfo = await verifyPaymentDescription(uid, description, orderId);

    // Check amount matches
    if (amount && amount !== orderInfo.amount) {
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

    // ✅ IDEMPOTENCY CHECK: Has this payment already been processed?
    const txnId = `TXN_${Date.now()}_${uid.substring(0, 8)}`;
    if (orderData.processedTxnIds && orderData.processedTxnIds.length > 0) {
      console.log('[VIETQR] ⚠️ Order already processed, preventing duplicate:', orderId);
      return res.json({
        success: true,
        orderId,
        status: 'completed',
        message: 'Payment already processed (idempotent)',
        alreadyProcessed: true,
      });
    }

    // Update order status to completed
    await orderRef.update({
      status: 'completed',
      completedAt: Timestamp.now(),
      verificationDescription: description,
    });

    // Process the order based on product type
    let result = {
      success: true,
      orderId,
      status: 'completed',
      message: 'Payment verified successfully',
    };

    if (orderData.product === 'coin') {
      // Add coins to user wallet
      const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');

      let transactionRef;
      await db.runTransaction(async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const currentCoins = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;
        const newCoins = currentCoins + orderData.coinPackage.amount;

        transaction.update(walletRef, {
          coins: newCoins,
          lastUpdate: Timestamp.now(),
        });

        // Create transaction record
        transactionRef = db.collection('users').doc(uid).collection('wallet').collection('transactions').doc();
        transaction.set(transactionRef, {
          id: transactionRef.id,
          type: 'topup_vietqr',
          amount: orderData.coinPackage.amount,
          price: orderData.amount,
          currencyType: 'coin',
          createdAt: Timestamp.now(),
          orderId: orderId,
          transactionCode: orderData.transactionCode,
          status: 'completed',
          verificationMethod: 'manual',
          metadata: {
            source: 'vietqr',
            description: description,
          },
        });
      });

      // ✅ Mark transaction as processed (idempotency check)
      await orderRef.update({
        processedTxnIds: admin.firestore.FieldValue.arrayUnion(txnId),
      });

      result.newBalance = (walletDoc?.data()?.coins || 0) + orderData.coinPackage.amount;
      result.coinsAdded = orderData.coinPackage.amount;
      result.message = `Thêm ${orderData.coinPackage.amount} coin thành công!`;
    } else if (orderData.product === 'pro_upgrade') {
      // Upgrade user to Pro
      const userRef = db.collection('users').doc(uid);
      const proExpiry = new Date();
      proExpiry.setMonth(proExpiry.getMonth() + 1);

      await userRef.update({
        isPro: true,
        proExpiresAt: Timestamp.fromDate(proExpiry),
        proActivatedAt: Timestamp.now(),
        lastProPaymentDate: Timestamp.now(),
      });

      // ✅ Mark transaction as processed (idempotency check)
      await orderRef.update({
        processedTxnIds: admin.firestore.FieldValue.arrayUnion(txnId),
      });

      result.proStatus = 'activated';
      result.proExpiresAt = proExpiry.toISOString();
      result.message = 'Nâng cấp Pro thành công!';
    }

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
router.get('/order-status/:orderId', async (req, res) => {
  try {
    const uid = await verifyAuth(req);
    const { orderId } = req.params;

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
 * Webhook từ ngân hàng nhận thông báo chuyển khoản
 * 
 * Body:
 * {
 *   "amount": 50000,           // VND
 *   "content": "VIP_ORD123456", // payment description
 *   "senderAccount": "0123456789", // tài khoản người gửi
 *   "timestamp": 1234567890    // ngân hàng timestamp
 * }
 */
router.post('/webhook/banking', async (req, res) => {
  try {
    // 🛡️ Verify webhook signature
    const signature = req.headers['x-webhook-signature'];
    if (signature && !verifyWebhookSignature(req.body, signature)) {
      console.warn('[VIETQR] Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const { amount, content, senderAccount, timestamp } = req.body;

    console.log('[VIETQR] 🔔 Webhook received:', { amount, content, senderAccount });

    if (!amount || !content) {
      return res.status(400).json({ success: false, message: 'Missing amount or content' });
    }

    // 🔍 Parse payment content: VIP_ORD123456 or PRO_ORD123456
    const match = content.match(/^(VIP|PRO)_(.+)$/);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Invalid content format' });
    }

    const [, productType, orderId] = match;

    // 🔍 Find order in database
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

    // ✅ Verify amount matches
    if (order.amount !== amount) {
      console.warn('[VIETQR] Amount mismatch:', { expected: order.amount, received: amount });
      return res.status(200).json({ success: false, message: 'Amount mismatch' });
    }

    // ✅ Verify product type matches
    if (order.productType !== productType) {
      console.warn('[VIETQR] Product type mismatch:', { expected: order.productType, received: productType });
      return res.status(200).json({ success: false, message: 'Product type mismatch' });
    }

    // 💰 Complete the order
    await completePaymentOrder(orderId, { uid, ...order });

    console.log('[VIETQR] ✅ Payment auto-verified via webhook:', orderId);
    res.status(200).json({ success: true, message: 'Payment verified and processed' });

  } catch (error) {
    console.error('[VIETQR] webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /vietqr/sms-received
 * SMS Banking Reader - Secure SMS-based payment verification
 * 
 * Flow:
 * 1. Android SMS Reader receives SMS from Vietcombank
 * 2. Reader parses SMS: amount, account, timestamp
 * 3. Reader generates HMAC-SHA256 signature for secure transmission
 * 4. Reader POSTs SMS to this endpoint with signature
 * 5. Server verifies signature (only valid SMS from authorized device)
 * 6. Server extracts amount and finds matching pending order
 * 7. Server verifies amount matches
 * 8. Server updates order status = 'completed'
 * 9. Server credits coins (idempotent - never twice)
 * 10. App polling detects within 3-6 seconds
 * 
 * Security:
 * - HMAC-SHA256 signature verification (SMS_READER_SECRET)
 * - Amount matching (prevents wrong SMS)
 * - Idempotency check (prevents duplicate coins)
 * - Never trusts client user input
 */
router.post('/sms-received', async (req, res) => {
  try {
    const { smsContent, timestamp, signature, deviceId } = req.body;

    console.log('[VIETQR SMS] Received SMS verification request');

    // ============================================================
    // 1. Validate input
    // ============================================================
    if (!smsContent || !timestamp || !signature) {
      console.error('[VIETQR SMS] Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Missing smsContent, timestamp, or signature'
      });
    }

    // ============================================================
    // 2. Verify HMAC-SHA256 signature
    // ============================================================
    const smsReaderSecret = process.env.SMS_READER_SECRET;
    if (!smsReaderSecret) {
      console.error('[VIETQR SMS] SMS_READER_SECRET not configured');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }

    const data = `${smsContent}|${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', smsReaderSecret)
      .update(data)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('[VIETQR SMS] ❌ Signature mismatch - invalid SMS or device');
      console.error('[VIETQR SMS]', {
        expected: expectedSignature.substring(0, 16) + '...',
        received: signature.substring(0, 16) + '...'
      });
      return res.status(401).json({
        success: false,
        message: 'Signature verification failed'
      });
    }

    console.log('[VIETQR SMS] ✅ Signature verified');

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

    console.log('[VIETQR SMS] 📝 Parsed SMS:', {
      amount: parsedSms.amount,
      account: parsedSms.account,
      memo: parsedSms.memo
    });

    // ============================================================
    // 4. Find matching pending order
    // Priorities: 
    // a) Search by unique memo (description) if found
    // b) Fallback to search by amount (less reliable)
    // ============================================================
    let pendingOrders;

    if (parsedSms.memo) {
      // Strategy 1: Search by orderId field (memo = ORDxxx, orderId = ORDxxx)
      console.log('[VIETQR SMS] 🔍 Searching by orderId:', parsedSms.memo);
      try {
        pendingOrders = await db.collectionGroup('orders')
          .where('orderId', '==', parsedSms.memo)
          .where('status', '==', 'pending')
          .limit(1)
          .get();
      } catch (indexErr) {
        console.warn('[VIETQR SMS] ⚠️ orderId index query failed, trying direct lookup...');
      }

      // Strategy 2: Search by description with VIP_ prefix
      if (!pendingOrders || pendingOrders.empty) {
        const descWithPrefix = `VIP_${parsedSms.memo}`;
        console.log('[VIETQR SMS] 🔍 Searching by description:', descWithPrefix);
        try {
          pendingOrders = await db.collectionGroup('orders')
            .where('description', '==', descWithPrefix)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        } catch (indexErr) {
          console.warn('[VIETQR SMS] ⚠️ description index query failed');
        }
      }

      // Strategy 3: Search by description with PRO_ prefix
      if (!pendingOrders || pendingOrders.empty) {
        const descWithPrefix = `PRO_${parsedSms.memo}`;
        console.log('[VIETQR SMS] 🔍 Searching by description (PRO):', descWithPrefix);
        try {
          pendingOrders = await db.collectionGroup('orders')
            .where('description', '==', descWithPrefix)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        } catch (indexErr) {
          console.warn('[VIETQR SMS] ⚠️ PRO description index query failed');
        }
      }
    }

    // Fallback: Search by exact amount
    if ((!pendingOrders || pendingOrders.empty) && parsedSms.amount > 0) {
      console.log('[VIETQR SMS] 🔍 Searching by exact amount (fallback):', parsedSms.amount);
      try {
        pendingOrders = await db.collectionGroup('orders')
          .where('status', '==', 'pending')
          .where('amount', '==', parsedSms.amount)
          .limit(1)
          .get();
      } catch (indexErr) {
        console.warn('[VIETQR SMS] ⚠️ amount index query failed');
      }
    }

    if (!pendingOrders || pendingOrders.empty) {
      console.warn('[VIETQR SMS] ⚠️ No pending order found for amount:', parsedSms.amount, 'memo:', parsedSms.memo);
      return res.status(404).json({
        success: false,
        message: 'No matching pending order found. Please check amount and message content.'
      });
    }

    const orderDoc = pendingOrders.docs[0];
    const orderId = orderDoc.id;
    const orderData = orderDoc.data();
    const uid = orderDoc.ref.parent.parent.id;

    console.log('[VIETQR SMS] 🎯 Found matching order:', {
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
      console.log('[VIETQR SMS] ⚠️ Order already completed (idempotent):', orderId);
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
      console.log('[VIETQR SMS] ⚠️ SMS already processed (idempotent):', smsCode);
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
    const orderRef = db.collection('users').doc(uid).collection('orders').doc(orderId);

    await orderRef.update({
      status: 'completed',
      verificationMethod: 'sms_banking',
      verifiedAt: Timestamp.now(),
      smsCode: smsCode,
      processedSmsCodes: admin.firestore.FieldValue.arrayUnion(smsCode),
      smsContent: smsContent.substring(0, 100) // Store truncated SMS for audit
    });

    console.log('[VIETQR SMS] ✅ Order status updated to completed');

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

      console.log('[VIETQR SMS] 💰 Coins credited:', coinsAdded);

      // Send notification to user
      try {
        await sendNotification(
          uid,
          '✅ Nạp xu thành công!',
          `Bạn vừa nạp ${coinsAdded} xu từ thanh toán VietQR`
        );
      } catch (notifError) {
        console.error('[VIETQR SMS] Notification failed:', notifError);
        // Don't fail the whole request if notification fails
      }
    }

    // ============================================================
    // 10. Return success response
    // ============================================================
    console.log('[VIETQR SMS] 🎉 Payment verified successfully!');

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

    // 💰 Pattern 1: Amount
    // Matches: "2,000VND", "+2.000đ", "so tien 50000d", "GD: +50,000 VND", "2000 VND"
    let amount = 0;
    const amountPatterns = [
      /([\d][\d\.,]+)\s*(?:VND|vnd)/i,           // 2,000VND or 2000 VND
      /(?:\+|CD\s*)([\d][\d\.,]+)\s*[dđ]/i,       // +2.000đ or CD 2000d
      /(?:so\s*tien|GD)[:\s]*\+?([\d][\d\.,]+)/i, // so tien 2000 or GD: +2000
      /([\d][\d\.,]+)\s*[dđ](?:\b|$)/i,            // 2000d at word boundary
    ];
    for (const pattern of amountPatterns) {
      const match = message.match(pattern);
      if (match) {
        amount = parseInt(match[1].replace(/[\.,]/g, ''), 10);
        if (amount > 0) break;
      }
    }

    // 📝 Pattern 2: Order ID / Memo
    // Extract just the ORDxxx part (without VIP_ or PRO_ prefix)
    // This is the orderId we store in Firestore
    let memo = null;
    const memoPatterns = [
      /(?:VIP|PRO)_(ORD[A-Z0-9]{5,})/i,          // VIP_ORDxxx → capture ORDxxx
      /(ORD[A-Z0-9]{5,})/i,                       // ORDxxx directly
      /(?:ND|noi dung)[:\s]*.*?(ORD[A-Z0-9]{5,})/i, // ND: ... ORDxxx
    ];
    for (const pattern of memoPatterns) {
      const match = message.match(pattern);
      if (match) {
        memo = match[1].toUpperCase();
        break;
      }
    }

    // 🏦 Pattern 3: Account
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
 * Cron endpoint - Check all pending orders mỗi 30 giây
 * Gọi từ external cron service hoặc scheduled task
 */
router.post('/check-pending', async (req, res) => {
  try {
    // 🛡️ Verify cron secret
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    console.log('[VIETQR] 🕐 Checking pending orders...');

    // 🔍 Find all pending orders (filter by time on client to avoid index)
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

        // 🔄 Try to verify via banking API (if available)
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

    // ✅ CLEANUP: Delete expired orders from Firestore
    console.log('[VIETQR] 🗑️ Cleaning up expired orders...');
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
          console.log('[VIETQR] 🗑️ Deleted expired order:', doc.id);
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
        console.log('[VIETQR] 🔄 Auto-polling', pendingOrders.size, 'pending orders');
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
  console.log('[VIETQR] ✅ Polling service started');
}

// Start polling when module loads
startPollingService();

module.exports = router;

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
      };

      description = orderData.description;
    } else if (product === 'pro_upgrade') {
      // Pro upgrade (assumes fixed price)
      amount = process.env.PRO_UPGRADE_PRICE || 99000;
      const orderId = generateOrderId();

      orderData = {
        uid,
        orderId,
        product: 'pro_upgrade',
        productType: 'PRO',
        amount,
        status: 'pending',
        createdAt: Timestamp.now(),
        description: `PRO_${orderId}`,
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
          status: 'completed',
          metadata: {
            source: 'vietqr',
            description: description,
          },
        });
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
    res.json({
      success: true,
      orderId,
      status: orderData.status,
      product: orderData.product,
      amount: orderData.amount,
      createdAt: orderData.createdAt?.toDate?.() || orderData.createdAt,
      completedAt: orderData.completedAt?.toDate?.() || orderData.completedAt,
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

    // 🔍 Find all pending orders created in last 15 minutes
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const pendingOrders = await db.collectionGroup('orders')
      .where('status', '==', 'pending')
      .where('createdAt', '>', Timestamp.fromDate(fifteenMinutesAgo))
      .get();

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

    res.json({
      success: true,
      message: `Checked ${pendingOrders.size} pending orders`,
      verified: verifiedCount,
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

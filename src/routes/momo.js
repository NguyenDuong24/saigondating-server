/**
 * MoMo Payment Routes
 * Xử lý thanh toán MoMo cho nạp coin và nâng cấp Pro
 */

const express = require('express');
const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const router = express.Router();
const db = getFirestore();

// ==============================================================
// MoMo API Configuration
// ==============================================================
const MOMO_CONFIG = {
    partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMOBKUN20180529',
    accessKey: process.env.MOMO_ACCESS_KEY || 'klm05TvNBzhg7h7j',
    secretKey: process.env.MOMO_SECRET_KEY || 'at67qH6mk8w5Y1nAyMoYKMWACiEi2bsa',

    // Sandbox URLs (đổi sang production khi go-live)
    endpoint: process.env.MOMO_ENDPOINT || 'https://test-payment.momo.vn/v2/gateway/api/create',

    // Callback URLs - Tạm thời dùng URL chuẩn để debug Code 99
    redirectUrl: process.env.MOMO_REDIRECT_URL || 'https://momo.vn',
    ipnUrl: process.env.MOMO_IPN_URL || 'https://webhook.site/b3b3b3b3-b3b3-4b3b-b3b3-b3b3b3b3b3b3',

    requestType: 'captureWallet',
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
        console.error('[MOMO] verifyIdToken failed:', verifyError);
        throw { status: 401, message: 'Invalid auth token' };
    }
}

/**
 * Tạo HMAC SHA256 signature cho MoMo
 */
function createSignature(rawData) {
    return crypto
        .createHmac('sha256', MOMO_CONFIG.secretKey)
        .update(rawData)
        .digest('hex');
}

/**
 * Xác thực signature từ MoMo callback
 */
function verifyCallbackSignature(data, signature) {
    const rawData = `accessKey=${MOMO_CONFIG.accessKey}&amount=${data.amount}&extraData=${data.extraData}&message=${data.message}&orderId=${data.orderId}&orderInfo=${data.orderInfo}&orderType=${data.orderType}&partnerCode=${data.partnerCode}&payType=${data.payType}&requestId=${data.requestId}&responseTime=${data.responseTime}&resultCode=${data.resultCode}&transId=${data.transId}`;
    const expectedSignature = createSignature(rawData);
    return expectedSignature === signature;
}

/**
 * Gọi MoMo API để tạo thanh toán
 */
async function createMoMoPayment(orderInfo) {
    const {
        orderId,
        requestId,
        amount,
        orderDescription,
        extraData,
    } = orderInfo;

    const amountStr = amount.toString();

    // Tạo raw signature
    const rawSignature = `accessKey=${MOMO_CONFIG.accessKey}&amount=${amountStr}&extraData=${extraData}&ipnUrl=${MOMO_CONFIG.ipnUrl}&orderId=${orderId}&orderInfo=${orderDescription}&partnerCode=${MOMO_CONFIG.partnerCode}&redirectUrl=${MOMO_CONFIG.redirectUrl}&requestId=${requestId}&requestType=${MOMO_CONFIG.requestType}`;

    console.log('🔑 [MOMO] Raw Signature:', rawSignature);
    const signature = createSignature(rawSignature);

    const requestBody = {
        partnerCode: MOMO_CONFIG.partnerCode,
        partnerName: 'ChappAt',
        storeId: 'ChappAtStore',
        requestId: requestId,
        amount: parseInt(amountStr),
        orderId: orderId,
        orderInfo: orderDescription,
        redirectUrl: MOMO_CONFIG.redirectUrl,
        ipnUrl: MOMO_CONFIG.ipnUrl,
        lang: 'vi',
        extraData: extraData,
        requestType: MOMO_CONFIG.requestType,
        signature: signature,
    };

    console.log('📦 [MOMO] Full Request Body:', JSON.stringify(requestBody, null, 2));

    console.log('📤 [MOMO] Request:', {
        orderId,
        amount,
        endpoint: MOMO_CONFIG.endpoint,
    });

    const response = await fetch(MOMO_CONFIG.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    console.log('📥 [MOMO] Response:', {
        resultCode: data.resultCode,
        message: data.message,
        orderId: data.orderId,
        requestId: data.requestId,
        responseTime: data.responseTime,
    });

    if (data.resultCode !== 0) {
        console.error('❌ [MOMO] API Error Detail:', data);
    }

    return data;
}

// ==============================================================
// Routes
// ==============================================================

/**
 * GET /api/momo/test
 * Route test nhanh để kiểm tra kết nối MoMo
 */
router.get('/test', async (req, res) => {
    try {
        const orderId = 'TEST' + Date.now();
        const result = await createMoMoPayment({
            orderId,
            requestId: orderId,
            amount: 10000,
            orderDescription: "Test MoMo Payment",
            extraData: ""
        });
        res.json({
            success: true,
            momoResponse: result
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/momo/create-payment
 * Tạo thanh toán MoMo mới
 */
router.post('/create-payment', async (req, res) => {
    try {
        const uid = await verifyAuth(req);
        console.log('[MOMO] Authenticated uid:', uid);

        const {
            amount,
            orderInfo,
            purchaseType, // 'coin' hoặc 'pro'
            coinAmount,   // Số coin (nếu purchaseType = 'coin')
            packageId,
            duration,     // Số ngày pro (nếu purchaseType = 'pro')
        } = req.body;

        // Validate - Tạm thời cho phép amount test
        if (!amount) {
            return res.status(400).json({
                success: false,
                error: 'Số tiền không hợp lệ',
                code: 'INVALID_AMOUNT',
            });
        }

        if (!['coin', 'pro'].includes(purchaseType)) {
            return res.status(400).json({
                success: false,
                error: 'Loại thanh toán không hợp lệ',
                code: 'INVALID_PURCHASE_TYPE',
            });
        }

        // Tạo order ID cực kỳ đơn giản
        const orderId = 'TR' + Math.floor(Math.random() * 1000000000);
        const requestId = orderId;

        // Extra data - Tạm thời để trống để debug Code 99
        const extraData = "";

        // Sanitize orderInfo to ASCII to avoid signature issues
        // Loại bỏ dấu tiếng Việt
        const sanitizeString = (str) => {
            return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
        };

        const safeOrderInfo = "Thanh toan ChappAt";

        // Gọi MoMo API
        const momoResponse = await createMoMoPayment({
            orderId,
            requestId,
            amount,
            orderDescription: safeOrderInfo,
            extraData,
        });

        if (momoResponse.resultCode !== 0) {
            console.error('❌ [MOMO] Create Payment Failed:', momoResponse);
            return res.status(400).json({
                success: false,
                error: momoResponse.message || 'Lỗi tạo thanh toán MoMo',
                code: 'MOMO_ERROR',
                detail: momoResponse,
                momoResultCode: momoResponse.resultCode
            });
        }

        // Lưu pending transaction vào Firestore
        await db.collection('momoTransactions').doc(orderId).set({
            orderId,
            requestId,
            userId: uid,
            amount,
            purchaseType,
            coinAmount: coinAmount || 0,
            duration: duration || 0,
            packageId: packageId || null,
            status: 'pending',
            createdAt: Timestamp.now(),
            momoPayUrl: momoResponse.payUrl,
            momoDeeplink: momoResponse.deeplink,
            momoQrCodeUrl: momoResponse.qrCodeUrl,
        });

        console.log('✅ [MOMO] Payment created:', {
            orderId,
            amount,
            purchaseType,
            payUrl: momoResponse.payUrl,
            deeplink: momoResponse.deeplink
        });

        res.json({
            success: true,
            orderId,
            payUrl: momoResponse.payUrl,
            deeplink: momoResponse.deeplink,
            qrCodeUrl: momoResponse.qrCodeUrl,
        });

    } catch (error) {
        console.error('❌ [MOMO] Create payment error:', error);
        if (error.status) {
            return res.status(error.status).json({ success: false, error: error.message });
        }
        res.status(500).json({
            success: false,
            error: 'Lỗi server',
            code: 'SERVER_ERROR',
        });
    }
});

/**
 * POST /api/momo/callback
 * Webhook từ MoMo (IPN - Instant Payment Notification)
 */
router.post('/callback', async (req, res) => {
    try {
        const data = req.body;

        console.log('📥 [MOMO] Callback received:', {
            orderId: data.orderId,
            resultCode: data.resultCode,
            transId: data.transId,
        });

        // Xác thực signature
        if (!verifyCallbackSignature(data, data.signature)) {
            console.error('❌ [MOMO] Invalid signature');
            return res.status(400).json({ success: false, error: 'Invalid signature' });
        }

        const orderId = data.orderId;
        const transactionRef = db.collection('momoTransactions').doc(orderId);
        const transactionDoc = await transactionRef.get();

        if (!transactionDoc.exists) {
            console.error('❌ [MOMO] Transaction not found:', orderId);
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }

        const transaction = transactionDoc.data();

        // Kiểm tra đã xử lý chưa
        if (transaction.status !== 'pending') {
            console.log('⚠️ [MOMO] Transaction already processed:', orderId);
            return res.json({ success: true, message: 'Already processed' });
        }

        // resultCode = 0 là thành công
        if (data.resultCode === 0) {
            // Cập nhật transaction status
            await transactionRef.update({
                status: 'success',
                momoTransId: data.transId,
                completedAt: Timestamp.now(),
                momoResponse: data,
            });

            // Thực hiện action dựa trên purchase type
            if (transaction.purchaseType === 'coin') {
                // Cộng coin cho user
                const walletRef = db.collection('users').doc(transaction.userId).collection('wallet').doc('balance');
                await db.runTransaction(async (t) => {
                    const walletDoc = await t.get(walletRef);
                    const currentCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
                    t.set(walletRef, {
                        coins: currentCoins + transaction.coinAmount,
                    }, { merge: true });
                });

                // Lưu vào transactions
                await db.collection('transactions').add({
                    uid: transaction.userId,
                    type: 'momo_topup',
                    amount: transaction.coinAmount,
                    momoOrderId: orderId,
                    momoTransId: data.transId,
                    timestamp: Timestamp.now(),
                });

                console.log(`✅ [MOMO] Added ${transaction.coinAmount} coins to user ${transaction.userId}`);

            } else if (transaction.purchaseType === 'pro') {
                // Nâng cấp Pro
                const userRef = db.collection('users').doc(transaction.userId);
                const now = new Date();
                const proExpiresAt = new Date(now.getTime() + transaction.duration * 24 * 60 * 60 * 1000);

                await userRef.update({
                    isPro: true,
                    proExpiresAt: Timestamp.fromDate(proExpiresAt),
                    proActivatedAt: Timestamp.now(),
                });

                console.log(`✅ [MOMO] Upgraded user ${transaction.userId} to Pro until ${proExpiresAt}`);
            }

            // TODO: Gửi push notification cho user

        } else {
            // Thanh toán thất bại
            await transactionRef.update({
                status: 'failed',
                failedAt: Timestamp.now(),
                momoResponse: data,
                failReason: data.message,
            });

            console.log('❌ [MOMO] Payment failed:', orderId, data.message);
        }

        // MoMo yêu cầu trả về 204 No Content
        res.status(204).send();

    } catch (error) {
        console.error('❌ [MOMO] Callback error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

/**
 * POST /api/momo/check-status
 * Kiểm tra trạng thái thanh toán
 */
router.post('/check-status', async (req, res) => {
    try {
        const uid = await verifyAuth(req);
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({
                success: false,
                error: 'Order ID is required',
                code: 'MISSING_ORDER_ID',
            });
        }

        const transactionDoc = await db.collection('momoTransactions').doc(orderId).get();

        if (!transactionDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'Transaction not found',
                code: 'TRANSACTION_NOT_FOUND',
            });
        }

        const transaction = transactionDoc.data();

        // Verify ownership
        if (transaction.userId !== uid) {
            return res.status(403).json({
                success: false,
                error: 'Unauthorized',
                code: 'UNAUTHORIZED',
            });
        }

        res.json({
            success: true,
            orderId: transaction.orderId,
            status: transaction.status,
            amount: transaction.amount,
            coinAmount: transaction.coinAmount,
            purchaseType: transaction.purchaseType,
            message: transaction.status === 'success'
                ? 'Thanh toán thành công'
                : transaction.status === 'failed'
                    ? transaction.failReason || 'Thanh toán thất bại'
                    : 'Đang chờ thanh toán',
        });

    } catch (error) {
        console.error('❌ [MOMO] Check status error:', error);
        if (error.status) {
            return res.status(error.status).json({ success: false, error: error.message });
        }
        res.status(500).json({
            success: false,
            error: 'Server error',
            code: 'SERVER_ERROR',
        });
    }
});

module.exports = router;

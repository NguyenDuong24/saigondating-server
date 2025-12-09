/**
 * User Routes
 * Pro status và message limits
 */

const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const router = express.Router();
const db = getFirestore();

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
        console.error('[USER] verifyIdToken failed:', verifyError);
        throw { status: 401, message: 'Invalid auth token' };
    }
}

/**
 * GET /api/user/pro-status
 * Lấy trạng thái Pro của user
 */
router.get('/pro-status', async (req, res) => {
    try {
        const uid = await verifyAuth(req);
        console.log('[USER] Getting pro status for:', uid);

        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
                code: 'USER_NOT_FOUND',
            });
        }

        const userData = userDoc.data();
        let isPro = userData.isPro || false;
        let proExpiresAt = userData.proExpiresAt ? userData.proExpiresAt.toDate() : null;

        // Kiểm tra xem Pro đã hết hạn chưa
        if (isPro && proExpiresAt && new Date() > proExpiresAt) {
            // Pro đã hết hạn, cập nhật user
            await db.collection('users').doc(uid).update({
                isPro: false,
            });
            isPro = false;
            console.log('[USER] Pro expired for user:', uid);
        }

        res.json({
            success: true,
            isPro,
            proExpiresAt: proExpiresAt ? proExpiresAt.toISOString() : null,
        });

    } catch (error) {
        console.error('❌ [USER] Get pro status error:', error);
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

/**
 * GET /api/user/message-limit
 * Lấy giới hạn tin nhắn của user (dựa trên Pro status)
 */
router.get('/message-limit', async (req, res) => {
    try {
        const uid = await verifyAuth(req);
        console.log('[USER] Getting message limit for:', uid);

        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'User not found',
                code: 'USER_NOT_FOUND',
            });
        }

        const userData = userDoc.data();
        let isPro = userData.isPro || false;
        const proExpiresAt = userData.proExpiresAt ? userData.proExpiresAt.toDate() : null;

        // Kiểm tra xem Pro đã hết hạn chưa
        if (isPro && proExpiresAt && new Date() > proExpiresAt) {
            isPro = false;
        }

        // Giới hạn tin nhắn: Pro = 500/ngày, Free = 50/ngày
        const messageLimit = isPro ? 500 : 50;

        // Đếm tin nhắn đã gửi hôm nay
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const messagesSentToday = userData.messagesSentToday || 0;
        const lastMessageDate = userData.lastMessageDate ? userData.lastMessageDate.toDate() : null;

        // Reset nếu ngày mới
        let actualMessagesSent = messagesSentToday;
        if (!lastMessageDate || lastMessageDate < today) {
            actualMessagesSent = 0;
        }

        res.json({
            success: true,
            isPro,
            messageLimit,
            messagesSentToday: actualMessagesSent,
            remaining: Math.max(0, messageLimit - actualMessagesSent),
        });

    } catch (error) {
        console.error('❌ [USER] Get message limit error:', error);
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

/**
 * POST /api/user/increment-message-count
 * Tăng số tin nhắn đã gửi trong ngày
 */
router.post('/increment-message-count', async (req, res) => {
    try {
        const uid = await verifyAuth(req);

        const userRef = db.collection('users').doc(uid);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                throw { status: 404, message: 'User not found' };
            }

            const userData = userDoc.data();
            const lastMessageDate = userData.lastMessageDate ? userData.lastMessageDate.toDate() : null;

            let messagesSentToday = userData.messagesSentToday || 0;

            // Reset nếu ngày mới
            if (!lastMessageDate || lastMessageDate < today) {
                messagesSentToday = 0;
            }

            // Kiểm tra giới hạn
            const isPro = userData.isPro || false;
            const proExpiresAt = userData.proExpiresAt ? userData.proExpiresAt.toDate() : null;
            const isProActive = isPro && (!proExpiresAt || new Date() <= proExpiresAt);
            const messageLimit = isProActive ? 500 : 50;

            if (messagesSentToday >= messageLimit) {
                throw { status: 429, message: 'Đã đạt giới hạn tin nhắn trong ngày' };
            }

            transaction.update(userRef, {
                messagesSentToday: messagesSentToday + 1,
                lastMessageDate: Timestamp.now(),
            });
        });

        res.json({ success: true });

    } catch (error) {
        console.error('❌ [USER] Increment message count error:', error);
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

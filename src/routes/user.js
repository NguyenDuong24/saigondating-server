/**
 * User Routes
 * Pro status và message limits
 */

const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const db = getFirestore();

const DEFAULT_NEW_CHAT_SETTINGS = {
    enabled: true,
    freeDailyLimit: 5,
    proDailyLimit: 20,
    unlockCostBanhMi: 1,
    unlockCostCoins: 10,
};

function getLocalDateKey(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return formatter.format(date);
}

async function getNewChatSettings() {
    const doc = await db.collection('system_config').doc('new_chat_settings').get();
    const data = doc.exists ? doc.data() : {};
    return {
        ...DEFAULT_NEW_CHAT_SETTINGS,
        ...data,
        freeDailyLimit: Number(data.freeDailyLimit ?? DEFAULT_NEW_CHAT_SETTINGS.freeDailyLimit),
        proDailyLimit: Number(data.proDailyLimit ?? DEFAULT_NEW_CHAT_SETTINGS.proDailyLimit),
        unlockCostBanhMi: Number(data.unlockCostBanhMi ?? DEFAULT_NEW_CHAT_SETTINGS.unlockCostBanhMi),
        unlockCostCoins: Number(data.unlockCostCoins ?? DEFAULT_NEW_CHAT_SETTINGS.unlockCostCoins),
        enabled: data.enabled !== false,
    };
}

async function getAdSettings() {
    const doc = await db.collection('system_config').doc('ad_settings').get();
    const data = doc.exists ? doc.data() : {};
    return {
        rewardAmount: Number(data.rewardAmount ?? 10),
        dailyLimit: Number(data.dailyLimit ?? 5),
        enabled: data.enabled !== false,
        interstitialEnabled: data.interstitialEnabled !== false,
        interstitialShowRate: Number(data.interstitialShowRate ?? 0.25),
        minSecondsBetweenInterstitials: Number(data.minSecondsBetweenInterstitials ?? 180),
        androidInterstitialAdUnitId: data.androidInterstitialAdUnitId || '',
        iosInterstitialAdUnitId: data.iosInterstitialAdUnitId || '',
    };
}

router.get('/app-config', async (req, res) => {
    try {
        const [ads, newChat] = await Promise.all([
            getAdSettings(),
            getNewChatSettings(),
        ]);

        res.json({
            success: true,
            ads,
            newChat,
        });
    } catch (error) {
        console.error('❌ [USER] Get app config error:', error);
        res.status(500).json({ success: false, error: 'Server error', code: 'SERVER_ERROR' });
    }
});

router.use(authMiddleware);

/**
 * GET /api/user/pro-status
 * Lấy trạng thái Pro của user
 */
router.get('/pro-status', async (req, res) => {
    try {
        const uid = req.user.uid;
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
        const uid = req.user.uid;
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
        const uid = req.user.uid;

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

/**
 * POST /api/user/new-chat/access
 * Checks and reserves access for starting a new 1:1 conversation today.
 */
router.post('/new-chat/access', async (req, res) => {
    try {
        const uid = req.user.uid;
        const { peerId, paymentCurrency } = req.body || {};

        if (!peerId || typeof peerId !== 'string' || peerId === uid) {
            return res.status(400).json({ success: false, error: 'Invalid peerId', code: 'INVALID_PEER' });
        }

        const settings = await getNewChatSettings();
        const userRef = db.collection('users').doc(uid);
        const roomId = [uid, peerId].sort().join('-');
        const roomRef = db.collection('rooms').doc(roomId);
        const accessRef = userRef.collection('new_chat_access').doc(peerId);
        const dailyRef = userRef.collection('usage').doc(`new_chats_${getLocalDateKey()}`);
        const walletRef = userRef.collection('wallet').doc('balance');

        let payload;
        await db.runTransaction(async (transaction) => {
            const [userDoc, roomDoc, accessDoc, dailyDoc, walletDoc] = await Promise.all([
                transaction.get(userRef),
                transaction.get(roomRef),
                transaction.get(accessRef),
                transaction.get(dailyRef),
                transaction.get(walletRef),
            ]);

            if (!userDoc.exists) {
                throw { status: 404, message: 'User not found', code: 'USER_NOT_FOUND' };
            }

            if (roomDoc.exists || accessDoc.exists || settings.enabled === false) {
                payload = { success: true, allowed: true, usedFreeQuota: false, unlocked: false, settings };
                return;
            }

            const userData = userDoc.data();
            const proExpiresAt = userData.proExpiresAt ? userData.proExpiresAt.toDate() : null;
            const isProActive = Boolean(userData.isPro) && (!proExpiresAt || new Date() <= proExpiresAt);
            const dailyLimit = isProActive ? settings.proDailyLimit : settings.freeDailyLimit;
            const dailyData = dailyDoc.exists ? dailyDoc.data() : {};
            const used = Number(dailyData.count || 0);

            if (used < dailyLimit) {
                transaction.set(dailyRef, {
                    count: used + 1,
                    dateKey: getLocalDateKey(),
                    updatedAt: Timestamp.now(),
                }, { merge: true });
                transaction.set(accessRef, {
                    peerId,
                    roomId,
                    source: 'free_daily_quota',
                    createdAt: Timestamp.now(),
                }, { merge: true });
                payload = {
                    success: true,
                    allowed: true,
                    usedFreeQuota: true,
                    remaining: Math.max(0, dailyLimit - used - 1),
                    dailyLimit,
                    settings,
                };
                return;
            }

            const currency = paymentCurrency === 'coins' ? 'coins' : paymentCurrency === 'banhMi' ? 'banhMi' : null;
            if (!currency) {
                payload = {
                    success: true,
                    allowed: false,
                    code: 'NEW_CHAT_LIMIT_REACHED',
                    dailyLimit,
                    remaining: 0,
                    cost: { banhMi: settings.unlockCostBanhMi, coins: settings.unlockCostCoins },
                };
                return;
            }

            const amount = currency === 'coins' ? settings.unlockCostCoins : settings.unlockCostBanhMi;
            const walletData = walletDoc.exists ? walletDoc.data() : {};
            const currentBalance = Number(walletData[currency] || 0);

            if (currentBalance < amount) {
                throw { status: 400, message: `Insufficient ${currency} balance`, code: 'INSUFFICIENT_FUNDS' };
            }

            const newBalance = currentBalance - amount;
            transaction.set(walletRef, { [currency]: newBalance }, { merge: true });
            transaction.set(accessRef, {
                peerId,
                roomId,
                source: 'paid_unlock',
                currencyType: currency,
                amount,
                createdAt: Timestamp.now(),
            }, { merge: true });
            transaction.set(db.collection('transactions').doc(), {
                uid,
                type: 'spend',
                currencyType: currency,
                amount,
                balance: newBalance,
                timestamp: Timestamp.now(),
                metadata: { source: 'new_chat_unlock', peerId, roomId },
            });

            payload = { success: true, allowed: true, unlocked: true, currencyType: currency, amount, newBalance, settings };
        });

        res.json(payload);
    } catch (error) {
        console.error('❌ [USER] New chat access error:', error);
        if (error.status) {
            return res.status(error.status).json({ success: false, error: error.message, code: error.code });
        }
        res.status(500).json({ success: false, error: 'Server error', code: 'SERVER_ERROR' });
    }
});

module.exports = router;

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const authMiddleware = require('../middleware/auth');
const { createIdempotencyMiddleware } = require('../middleware/idempotency');
const router = express.Router();
const db = getFirestore();

/**
 * Helper to safely get milliseconds from a Firestore value (handles Timestamp, Date, or Number)
 */
function asSafeMillis(val) {
    if (!val) return 0;
    if (typeof val.toMillis === 'function') return val.toMillis();
    if (val instanceof Date) return val.getTime();
    if (typeof val === 'number') return val;
    const n = Number(val);
    return Number.isNaN(n) ? 0 : n;
}

router.use(authMiddleware);

function userRateLimitKey(req) {
    return req.user?.uid || req.ip;
}

const tokenLimiter = rateLimit({
    windowMs: Number(process.env.VIDEOSDK_TOKEN_RATE_WINDOW_MS || 15 * 60 * 1000),
    max: Number(process.env.VIDEOSDK_TOKEN_RATE_MAX || 80),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userRateLimitKey,
    message: { success: false, code: 'VIDEOSDK_TOKEN_RATE_LIMIT', error: 'Too many VideoSDK token requests' },
});

const roomCreateLimiter = rateLimit({
    windowMs: Number(process.env.VIDEOSDK_ROOM_RATE_WINDOW_MS || 60 * 1000),
    max: Number(process.env.VIDEOSDK_ROOM_RATE_MAX || 6),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userRateLimitKey,
    message: { success: false, code: 'VIDEOSDK_ROOM_RATE_LIMIT', error: 'Too many VideoSDK room requests' },
});

const idempotency = createIdempotencyMiddleware({
    ttlMs: Number(process.env.VIDEOSDK_IDEMPOTENCY_TTL_MS || 5 * 60 * 1000),
    lockMs: Number(process.env.VIDEOSDK_IDEMPOTENCY_LOCK_MS || 15 * 1000),
});

const CALL_TYPES = new Set(['audio', 'video']);

function numberFromEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function boundedNumberFromEnv(name, fallback, min, max) {
    const value = numberFromEnv(name, fallback);
    return Math.min(Math.max(value, min), max);
}

function boundedNumber(value, fallback, min, max) {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.min(Math.max(safe, min), max);
}

function isValidId(value, maxLength = 128) {
    return typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        /^[A-Za-z0-9_.:-]+$/.test(value);
}

function getDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getVideoSdkKeys() {
    const API_KEY = process.env.VIDEOSDK_API_KEY;
    const SECRET_KEY = process.env.VIDEOSDK_SECRET_KEY || process.env.VIDEOSDK_API_SECRET || process.env.VIDEOSDK_SECRET;

    if (!API_KEY || !SECRET_KEY) {
        const missing = [
            !API_KEY ? 'VIDEOSDK_API_KEY' : null,
            !SECRET_KEY ? 'VIDEOSDK_SECRET_KEY' : null,
        ].filter(Boolean);
        console.error(`VideoSDK configuration missing: ${missing.join(', ')}`);
        const error = new Error(`VideoSDK keys are not configured. Missing: ${missing.join(', ')}`);
        error.status = 500;
        error.code = 'VIDEOSDK_KEYS_MISSING';
        throw error;
    }

    return { API_KEY, SECRET_KEY };
}

function signVideoSdkToken(uid, options = {}) {
    const { API_KEY, SECRET_KEY } = getVideoSdkKeys();
    const ttlMinutes = options.ttlMinutes
        ? boundedNumber(options.ttlMinutes, 30, 1, 60)
        : boundedNumberFromEnv('VIDEOSDK_JOIN_TOKEN_TTL_MINUTES', 30, 1, 60);

    const payload = {
        apikey: API_KEY,
        permissions: options.permissions || ['allow_join'],
        version: 2,
        uid,
    };

    if (options.roomId) {
        payload.roomId = options.roomId;
    }

    return jwt.sign(payload, SECRET_KEY, {
        expiresIn: `${ttlMinutes}m`,
        algorithm: 'HS256',
    });
}

async function createVideoSdkRoom(uid) {
    const roomToken = signVideoSdkToken(uid, {
        permissions: ['allow_join', 'allow_mod'],
        ttlMinutes: boundedNumberFromEnv('VIDEOSDK_ROOM_CREATE_TOKEN_TTL_MINUTES', 10, 1, 15),
    });

    const fetchRoom = async () => {
        const response = await fetch('https://api.videosdk.live/v2/rooms', {
            method: 'POST',
            headers: {
                authorization: roomToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorJson = null;
            try { errorJson = JSON.parse(errorText); } catch { /* ignore */ }

            // Log full VideoSDK error so it appears in Render dashboard
            console.error('[VideoSDK] Room create failed:', {
                httpStatus: response.status,
                body: errorJson || errorText.slice(0, 500),
            });

            const error = new Error(
                `VideoSDK room create failed: ${response.status} ${errorJson?.message || errorText.slice(0, 120)}`
            );
            error.status = 502;
            error.code = 'VIDEOSDK_UPSTREAM_ERROR';
            error.details = {
                videosdkStatus: response.status,
                videosdkBody: errorJson || errorText.slice(0, 300),
            };
            throw error;
        }

        const data = await response.json();
        if (!data.roomId) {
            const error = new Error('VideoSDK did not return a roomId');
            error.status = 502;
            error.code = 'VIDEOSDK_NO_ROOM_ID';
            throw error;
        }
        return data.roomId;
    };

    // One retry for transient errors (502/503/504)
    try {
        return await fetchRoom();
    } catch (firstError) {
        const isTransient = firstError.details?.videosdkStatus >= 500;
        if (isTransient) {
            console.warn('[VideoSDK] Transient error, retrying in 1s...', firstError.message);
            await new Promise(r => setTimeout(r, 1000));
            return await fetchRoom(); // let second error propagate naturally
        }
        throw firstError;
    }
}

async function getUserTier(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    const user = userDoc.exists ? userDoc.data() || {} : {};
    return user.isPremium || user.subscriptionStatus === 'active' ? 'premium' : 'free';
}

async function assertReceiverExists(receiverId) {
    const receiverDoc = await db.collection('users').doc(receiverId).get();
    if (!receiverDoc.exists) {
        const error = new Error('Receiver not found');
        error.status = 404;
        error.code = 'RECEIVER_NOT_FOUND';
        throw error;
    }
}

async function assertNotBlocked(callerId, receiverId) {
    const [callerBlockedReceiver, receiverBlockedCaller] = await Promise.all([
        db.collection('blocks')
            .where('blockerId', '==', callerId)
            .where('blockedId', '==', receiverId)
            .limit(1)
            .get(),
        db.collection('blocks')
            .where('blockerId', '==', receiverId)
            .where('blockedId', '==', callerId)
            .limit(1)
            .get(),
    ]);

    if (!callerBlockedReceiver.empty || !receiverBlockedCaller.empty) {
        const error = new Error('Call is not allowed for this relationship');
        error.status = 403;
        error.code = 'CALL_BLOCKED';
        throw error;
    }
}

async function assertNoActiveOutgoingCall(uid) {
    const activeStatuses = ['ringing', 'accepted'];
    const activeCalls = await db.collection('calls')
        .where('callerId', '==', uid)
        .where('status', 'in', activeStatuses)
        .limit(1)
        .get();

    if (!activeCalls.empty) {
        const error = new Error('You already have an active call');
        error.status = 429;
        error.code = 'ACTIVE_CALL_EXISTS';
        throw error;
    }
}

async function rememberVideoRoom(roomId, uid, receiverId, tier, maxDurationSeconds, metadata) {
    const participants = receiverId ? [uid, receiverId] : [uid];
    const now = Timestamp.now();

    await db.collection('video_rooms').doc(roomId).set({
        roomId,
        createdBy: uid,
        participants,
        type: receiverId ? 'private_call' : String(metadata?.source || 'standalone').slice(0, 40),
        tier,
        maxDurationSeconds,
        createdAt: now,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(Date.now() + maxDurationSeconds * 1000),
    }, { merge: true });
}

async function assertCanJoinRoom(uid, roomId) {
    const roomDoc = await db.collection('video_rooms').doc(roomId).get();
    if (roomDoc.exists) {
        const data = roomDoc.data() || {};
        if (Array.isArray(data.participants) && data.participants.includes(uid)) {
            return;
        }
        if (data.createdBy === uid) {
            return;
        }
    }

    const [callerCall, receiverCall, groupRoom] = await Promise.all([
        db.collection('calls')
            .where('meetingId', '==', roomId)
            .where('callerId', '==', uid)
            .limit(1)
            .get(),
        db.collection('calls')
            .where('meetingId', '==', roomId)
            .where('receiverId', '==', uid)
            .limit(1)
            .get(),
        db.collection('groups')
            .where('voiceRoomId', '==', roomId)
            .where('members', 'array-contains', uid)
            .limit(1)
            .get(),
    ]);

    if (!callerCall.empty || !receiverCall.empty || !groupRoom.empty) {
        return;
    }

    const error = new Error('You are not allowed to join this room');
    error.status = 403;
    error.code = 'ROOM_ACCESS_DENIED';
    throw error;
}

/**
 * Reserve daily quota for a call.
 * Tracks:
 *   - callsCreated          (total calls today)
 *   - audioSecondsUsed      (cumulative audio seconds budget consumed)
 *   - videoSecondsUsed      (cumulative video seconds budget consumed)
 *   - cooldownUntil          (anti-spam cooldown)
 *
 * Returns the max allowed seconds for THIS call.
 */
async function reserveDailyQuota(uid, tier, callType) {
    const dayKey = getDayKey();
    const usageRef = db.collection('call_usage').doc(`${uid}_${dayKey}`);
    const now = Timestamp.now();

    // ── Limits based on tier ────────────────────────────────────
    const isPremium = tier === 'premium';

    const dailyCallCount = isPremium
        ? numberFromEnv('VIDEOSDK_DAILY_CALLS_PREMIUM', 120)
        : numberFromEnv('VIDEOSDK_DAILY_CALLS_FREE', 20);

    const dailyAudioBudget = isPremium
        ? numberFromEnv('VIDEOSDK_DAILY_AUDIO_SECONDS_PREMIUM', 120 * 60)
        : numberFromEnv('VIDEOSDK_DAILY_AUDIO_SECONDS_FREE', 20 * 60);

    const dailyVideoBudget = isPremium
        ? numberFromEnv('VIDEOSDK_DAILY_VIDEO_SECONDS_PREMIUM', 60 * 60)
        : numberFromEnv('VIDEOSDK_DAILY_VIDEO_SECONDS_FREE', 5 * 60);

    const maxPerCallAudio = isPremium
        ? numberFromEnv('VIDEOSDK_MAX_AUDIO_CALL_SECONDS_PREMIUM', 60 * 60)
        : numberFromEnv('VIDEOSDK_MAX_AUDIO_CALL_SECONDS_FREE', 20 * 60);

    const maxPerCallVideo = isPremium
        ? numberFromEnv('VIDEOSDK_MAX_VIDEO_CALL_SECONDS_PREMIUM', 30 * 60)
        : numberFromEnv('VIDEOSDK_MAX_VIDEO_CALL_SECONDS_FREE', 5 * 60);

    const cooldownSeconds = numberFromEnv('VIDEOSDK_CREATE_COOLDOWN_SECONDS', 8);

    let maxDurationForThisCall = 0;

    await db.runTransaction(async (transaction) => {
        const usageSnap = await transaction.get(usageRef);
        const usage = usageSnap.exists ? usageSnap.data() || {} : {};
        const callsCreated = Number(usage.callsCreated || 0);
        const cooldownUntil = asSafeMillis(usage.cooldownUntil);
        const audioUsed = Number(usage.audioSecondsUsed || 0);
        const videoUsed = Number(usage.videoSecondsUsed || 0);

        // ── Anti-spam: call count ────────────────────────────────
        if (callsCreated >= dailyCallCount) {
            const error = new Error('Bạn đã đạt giới hạn cuộc gọi trong ngày');
            error.status = 429;
            error.code = 'DAILY_CALL_LIMIT';
            error.details = { current: callsCreated, max: dailyCallCount };
            throw error;
        }

        // ── Anti-spam: cooldown ──────────────────────────────────
        if (cooldownUntil > Date.now()) {
            const error = new Error('Vui lòng chờ trước khi tạo cuộc gọi mới');
            error.status = 429;
            error.code = 'CALL_COOLDOWN';
            error.details = { retryAfterMs: cooldownUntil - Date.now() };
            throw error;
        }

        // ── Daily budget check for the specific call type ───────
        const isVideo = callType === 'video';
        const usedSeconds = isVideo ? videoUsed : audioUsed;
        const dailyBudget = isVideo ? dailyVideoBudget : dailyAudioBudget;
        const maxPerCall = isVideo ? maxPerCallVideo : maxPerCallAudio;

        const remainingBudget = Math.max(0, dailyBudget - usedSeconds);
        if (remainingBudget <= 0) {
            const typeLabel = isVideo ? 'video' : 'thoại';
            const error = new Error(`Bạn đã hết thời lượng cuộc gọi ${typeLabel} miễn phí hôm nay`);
            error.status = 429;
            error.code = isVideo ? 'DAILY_VIDEO_LIMIT' : 'DAILY_AUDIO_LIMIT';
            error.details = { usedSeconds, dailyBudget, callType };
            throw error;
        }

        // The call gets the lesser of: per-call max OR remaining daily budget
        maxDurationForThisCall = Math.min(maxPerCall, remainingBudget);

        // Reserve the full max duration optimistically.
        // (A post-call webhook or client report can refund unused seconds later if needed.)
        const budgetField = isVideo ? 'videoSecondsUsed' : 'audioSecondsUsed';

        transaction.set(usageRef, {
            uid,
            dayKey,
            tier,
            callsCreated: FieldValue.increment(1),
            [budgetField]: FieldValue.increment(maxDurationForThisCall),
            [`${callType}CallsCreated`]: FieldValue.increment(1),
            cooldownUntil: Timestamp.fromMillis(Date.now() + cooldownSeconds * 1000),
            updatedAt: now,
            createdAt: usage.createdAt || now,
        }, { merge: true });
    });

    return maxDurationForThisCall;
}

function sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
    const safe = {};
    Object.entries(metadata).slice(0, 12).forEach(([key, value]) => {
        const safeKey = String(key).slice(0, 40);
        if (['string', 'number', 'boolean'].includes(typeof value)) {
            safe[safeKey] = typeof value === 'string' ? value.slice(0, 200) : value;
        }
    });
    return safe;
}

/**
 * GET /videosdk/diag
 * Auth-protected diagnostic: tests if VideoSDK keys are configured and can create a room.
 * Use this to debug 502 errors from VideoSDK.
 */
router.get('/diag', async (req, res) => {
    try {
        // 1. Check keys
        let keysOk = false;
        let keyError = null;
        try {
            getVideoSdkKeys();
            keysOk = true;
        } catch (e) {
            keyError = e.message;
        }

        if (!keysOk) {
            return res.json({ ok: false, step: 'keys', error: keyError });
        }

        // 2. Try to sign a token
        let token = null;
        try {
            token = signVideoSdkToken('diag-user', {
                permissions: ['allow_join', 'allow_mod'],
                ttlMinutes: 5,
            });
        } catch (e) {
            return res.json({ ok: false, step: 'sign_token', error: e.message });
        }

        // 3. Try to create a room
        const response = await fetch('https://api.videosdk.live/v2/rooms', {
            method: 'POST',
            headers: {
                authorization: token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        const responseText = await response.text();
        let responseJson = null;
        try { responseJson = JSON.parse(responseText); } catch { /* ignore */ }

        return res.json({
            ok: response.ok,
            step: 'create_room',
            httpStatus: response.status,
            videosdkResponse: responseJson || responseText.slice(0, 500),
            tokenPreview: token.slice(0, 60) + '...',
        });
    } catch (e) {
        res.status(500).json({ ok: false, step: 'unexpected', error: e.message });
    }
});

/**
 * GET /videosdk/token
 * Generate a new VideoSDK token for the authenticated user
 */
router.get('/token', tokenLimiter, async (req, res) => {
    try {
        const roomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim() : '';
        if (!isValidId(roomId, 128)) {
            return res.status(400).json({
                success: false,
                code: 'ROOM_ID_REQUIRED',
                error: 'A valid roomId is required',
            });
        }

        await assertCanJoinRoom(req.user.uid, roomId);

        const token = signVideoSdkToken(req.user.uid, {
            roomId,
        });

        res.json({
            success: true,
            token
        });

    } catch (error) {
        console.error('VideoSDK token error:', error);
        res.status(error.status || 500).json({
            success: false,
            code: error.code || 'VIDEOSDK_TOKEN_FAILED',
            error: error.status === 500 ? 'Failed to generate token' : error.message,
        });
    }
});

/**
 * POST /videosdk/rooms
 * Create a VideoSDK room on the server so the client never exposes a room-create token.
 * If receiverId is provided, also creates the Firebase call document atomically enough
 * for the mobile caller flow.
 */
/**
 * POST /api/videosdk/rooms
 * IMPORTANT: reserveDailyQuota is ONLY called here. 
 * Since ONLY the caller (the one starting the call) hits this endpoint,
 * ONLY the caller's budget is limited/deducted. The receiver simply joins the room.
 */
router.post('/rooms', roomCreateLimiter, idempotency, async (req, res) => {
    try {
        const uid = req.user.uid;
        const receiverId = typeof req.body?.receiverId === 'string' ? req.body.receiverId.trim() : '';
        const callType = typeof req.body?.callType === 'string' ? req.body.callType.trim() : 'video';
        const metadata = sanitizeMetadata(req.body?.metadata);

        if (!CALL_TYPES.has(callType)) {
            return res.status(400).json({ success: false, code: 'INVALID_CALL_TYPE', error: 'Invalid call type' });
        }

        if (receiverId && receiverId === uid) {
            return res.status(400).json({ success: false, code: 'SELF_CALL', error: 'Cannot call yourself' });
        }

        if (receiverId) {
            if (!isValidId(receiverId, 128)) {
                return res.status(400).json({ success: false, code: 'INVALID_RECEIVER', error: 'Invalid receiverId' });
            }
            await assertReceiverExists(receiverId);
            await assertNotBlocked(uid, receiverId);
            await assertNoActiveOutgoingCall(uid);
        }

        const tier = await getUserTier(uid);

        // ── IMPORTANT: Create the VideoSDK room FIRST, then reserve quota.
        // If we reserve quota first and the VideoSDK API fails, the user gets
        // stuck in a 8s cooldown for no reason.
        const roomId = await createVideoSdkRoom(uid);
        const joinToken = signVideoSdkToken(uid, { roomId });

        // Now that we have a real room, deduct from the daily budget
        const maxDurationSeconds = await reserveDailyQuota(uid, tier, receiverId ? callType : 'room');

        await rememberVideoRoom(roomId, uid, receiverId, tier, maxDurationSeconds, metadata);

        let callId = null;
        if (receiverId) {
            const callRef = db.collection('calls').doc();
            const now = Timestamp.now();

            await callRef.set({
                callerId: uid,
                receiverId,
                meetingId: roomId,
                type: callType,
                status: 'ringing',
                createdAt: now,
                updatedAt: now,
                serverCreated: true,
                costPolicy: {
                    tier,
                    callType,
                    maxDurationSeconds,
                    ringTimeoutSeconds: numberFromEnv('VIDEOSDK_RING_TIMEOUT_SECONDS', 30),
                },
                metadata,
            });
            callId = callRef.id;
        }

        res.json({
            success: true,
            roomId,
            meetingId: roomId,
            token: joinToken,
            callId,
            quota: {
                tier,
                dayKey: getDayKey(),
            },
        });

    } catch (error) {
        console.error('VideoSDK room error:', {
            message: error.message,
            code: error.code,
            status: error.status,
            details: error.details,
            stack: error.stack?.split('\n').slice(0, 4).join(' | '),
        });
        res.status(error.status || 500).json({
            success: false,
            code: error.code || 'VIDEOSDK_ROOM_FAILED',
            error: error.status ? error.message : 'Failed to create VideoSDK room',
            details: error.details,
        });
    }
});

module.exports = router;

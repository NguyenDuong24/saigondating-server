/**
 * Admin Routes
 * Protected endpoints for admin panel operations
 */

const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();

// ============== WALLET MANAGEMENT ==============

/**
 * GET /admin/wallet/stats
 * Get system-wide wallet statistics
 */
router.get('/wallet/stats', async (req, res) => {
    try {
        console.log('📊 Admin: Getting wallet stats');

        // Get all user wallet balances
        const usersSnapshot = await db.collection('users').limit(1000).get();

        let totalCoins = 0;
        let totalBanhMi = 0;
        let userCount = 0;

        for (const doc of usersSnapshot.docs) {
            userCount++;
            const walletRef = db.collection('users').doc(doc.id).collection('wallet').doc('balance');
            const walletSnap = await walletRef.get();

            if (walletSnap.exists) {
                const data = walletSnap.data();
                totalCoins += data.coins || 0;
                totalBanhMi += data.banhMi || 0;
            }
        }

        // Get transaction statistics
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // Count transactions (sample from users)
        let dailyTransactions = 0;
        let weeklyTransactions = 0;

        for (const doc of usersSnapshot.docs) {
            const txQuery = db.collection('users').doc(doc.id).collection('wallet').doc('balance')
                .collection('transactions')
                .where('timestamp', '>=', Timestamp.fromDate(oneDayAgo));

            const txSnap = await txQuery.get();
            dailyTransactions += txSnap.size;

            const weekQuery = db.collection('users').doc(doc.id).collection('wallet').doc('balance')
                .collection('transactions')
                .where('timestamp', '>=', Timestamp.fromDate(oneWeekAgo));

            const weekSnap = await weekQuery.get();
            weeklyTransactions += weekSnap.size;
        }

        res.json({
            success: true,
            stats: {
                totalCoins,
                totalBanhMi,
                userCount,
                transactions: {
                    daily: dailyTransactions,
                    weekly: weeklyTransactions
                },
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error getting wallet stats:', error);
        res.status(500).json({
            error: 'Failed to get wallet statistics',
            code: 'SERVER_ERROR',
            details: error.message
        });
    }
});

/**
 * POST /admin/wallet/adjust
 * Manually adjust a user's wallet balance
 * Body: { userId, amount, currencyType, reason }
 */
router.post('/wallet/adjust', async (req, res) => {
    try {
        const { userId, amount, currencyType = 'coins', reason } = req.body;

        if (!userId || amount === undefined || amount === null) {
            return res.status(400).json({
                error: 'Missing required fields',
                code: 'INVALID_REQUEST',
                details: 'userId and amount are required'
            });
        }

        if (!['coins', 'banhMi'].includes(currencyType)) {
            return res.status(400).json({
                error: 'Invalid currency type',
                code: 'INVALID_REQUEST',
                details: 'currencyType must be "coins" or "banhMi"'
            });
        }

        const adjustmentAmount = Number(amount);
        if (isNaN(adjustmentAmount)) {
            return res.status(400).json({
                error: 'Invalid amount',
                code: 'INVALID_REQUEST',
                details: 'amount must be a number'
            });
        }

        console.log(`💰 Admin: Adjusting ${currencyType} for user ${userId}: ${adjustmentAmount >= 0 ? '+' : ''}${adjustmentAmount}`);

        // Update balance
        const balanceRef = db.collection('users').doc(userId).collection('wallet').doc('balance');

        await db.runTransaction(async (transaction) => {
            const balanceDoc = await transaction.get(balanceRef);

            let currentBalance = 0;
            if (balanceDoc.exists) {
                const data = balanceDoc.data();
                currentBalance = data[currencyType] || 0;
            }

            const newBalance = currentBalance + adjustmentAmount;

            if (newBalance < 0) {
                throw new Error(`Insufficient balance. Current: ${currentBalance}, Adjustment: ${adjustmentAmount}`);
            }

            // Update balance
            transaction.set(balanceRef, {
                [currencyType]: newBalance,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            // Record transaction
            const txRef = balanceRef.collection('transactions').doc();
            transaction.set(txRef, {
                type: 'admin_adjustment',
                amount: adjustmentAmount,
                currencyType,
                timestamp: Timestamp.now(),
                adminId: req.user.uid,
                adminEmail: req.user.email,
                reason: reason || 'Manual admin adjustment',
                balanceBefore: currentBalance,
                balanceAfter: newBalance
            });
        });

        res.json({
            success: true,
            message: 'Balance adjusted successfully',
            adjustment: {
                userId,
                amount: adjustmentAmount,
                currencyType,
                reason: reason || 'Manual admin adjustment'
            }
        });

    } catch (error) {
        console.error('Error adjusting balance:', error);
        res.status(500).json({
            error: 'Failed to adjust balance',
            code: 'SERVER_ERROR',
            details: error.message
        });
    }
});

/**
 * GET /admin/transactions
 * Get paginated transaction history with filters
 * Query params: limit, userId, type, startDate, endDate
 */
router.get('/transactions', async (req, res) => {
    try {
        const { limit = 50, userId, type, startDate, endDate } = req.query;

        console.log('📜 Admin: Getting transactions with filters:', { limit, userId, type, startDate, endDate });

        let transactions = [];

        if (userId) {
            // Get transactions for specific user
            const balanceRef = db.collection('users').doc(userId).collection('wallet').doc('balance');
            let query = balanceRef.collection('transactions')
                .orderBy('timestamp', 'desc')
                .limit(Number(limit));

            if (type) {
                query = query.where('type', '==', type);
            }

            if (startDate) {
                const start = new Date(startDate);
                query = query.where('timestamp', '>=', Timestamp.fromDate(start));
            }

            if (endDate) {
                const end = new Date(endDate);
                query = query.where('timestamp', '<=', Timestamp.fromDate(end));
            }

            const snapshot = await query.get();
            transactions = snapshot.docs.map(doc => ({
                id: doc.id,
                userId,
                ...doc.data(),
                timestamp: doc.data().timestamp?.toDate?.()?.toISOString() || doc.data().timestamp
            }));

        } else {
            // Get transactions from multiple users (limited sample)
            const usersSnapshot = await db.collection('users').limit(20).get();

            for (const userDoc of usersSnapshot.docs) {
                const balanceRef = db.collection('users').doc(userDoc.id).collection('wallet').doc('balance');
                let query = balanceRef.collection('transactions')
                    .orderBy('timestamp', 'desc')
                    .limit(5);

                const txSnapshot = await query.get();
                const userTxs = txSnapshot.docs.map(doc => ({
                    id: doc.id,
                    userId: userDoc.id,
                    ...doc.data(),
                    timestamp: doc.data().timestamp?.toDate?.()?.toISOString() || doc.data().timestamp
                }));

                transactions.push(...userTxs);
            }

            // Sort all transactions by timestamp
            transactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            transactions = transactions.slice(0, Number(limit));
        }

        res.json({
            success: true,
            transactions,
            count: transactions.length
        });

    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({
            error: 'Failed to get transactions',
            code: 'SERVER_ERROR',
            details: error.message
        });
    }
});

// ============== USER MANAGEMENT ==============

/**
 * POST /admin/users/:userId/ban
 * Ban a user
 */
router.post('/users/:userId/ban', async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        console.log(`🚫 Admin: Banning user ${userId}`);

        await db.collection('users').doc(userId).update({
            banned: true,
            bannedAt: FieldValue.serverTimestamp(),
            bannedBy: req.user.uid,
            banReason: reason || 'No reason provided'
        });

        res.json({
            success: true,
            message: 'User banned successfully'
        });

    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({
            error: 'Failed to ban user',
            code: 'SERVER_ERROR',
            details: error.message
        });
    }
});

/**
 * POST /admin/users/:userId/unban
 * Unban a user
 */
router.post('/users/:userId/unban', async (req, res) => {
    try {
        const { userId } = req.params;

        console.log(`✅ Admin: Unbanning user ${userId}`);

        await db.collection('users').doc(userId).update({
            banned: false,
            unbannedAt: FieldValue.serverTimestamp(),
            unbannedBy: req.user.uid
        });

        res.json({
            success: true,
            message: 'User unbanned successfully'
        });

    } catch (error) {
        console.error('Error unbanning user:', error);
        res.status(500).json({
            error: 'Failed to unban user',
            code: 'SERVER_ERROR',
            details: error.message
        });
    }
});

module.exports = router;

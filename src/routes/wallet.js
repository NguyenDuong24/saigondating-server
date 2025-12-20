const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const router = express.Router();
const db = getFirestore();

// ============== WALLET ROUTES ==============

/**
 * GET /wallet/balance
 * Get user's coin balance
 */
router.get('/balance', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
      console.error('[WALLET] verifyIdToken failed:', verifyError);
      return res.status(401).json({ success: false, error: 'Invalid auth token' });
    }
    const uid = decodedToken.uid;
    console.log('[WALLET] Authenticated uid:', uid);

    // Get user wallet
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    const walletDoc = await walletRef.get();

    let coins = 0;
    if (walletDoc.exists) {
      coins = walletDoc.data().coins || 0;
    }

    res.json({
      success: true,
      coins,
      uid
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to get balance' });
  }
});

/**
 * POST /wallet/topup
 * Add coins to user's balance
 */
router.post('/topup', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
      console.error('[WALLET] verifyIdToken failed:', verifyError);
      return res.status(401).json({ success: false, error: 'Invalid auth token' });
    }
    const uid = decodedToken.uid;
    console.log('[WALLET] Authenticated uid:', uid);

    const { amount, metadata = {} } = req.body;

    if (!amount || amount < 1 || amount > 1000) {
      return res.status(400).json({ success: false, error: 'Invalid amount (1-1000)' });
    }

    // SECURITY: Only allow manual topup in Development environment
    if (process.env.NODE_ENV !== 'development') {
      console.warn('[SECURITY] Blocked attempt to use manual topup in production from uid:', uid);
      return res.status(403).json({
        success: false,
        error: 'Manual topup is disabled in production. Please use official payment methods.'
      });
    }

    // Update balance
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    console.log('[WALLET TOPUP] uid:', uid, 'amount:', amount);
    let transactionRef;
    await db.runTransaction(async (transaction) => {
      const walletDoc = await transaction.get(walletRef);
      const rawCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
      const currentCoins = isNaN(Number(rawCoins)) ? 0 : Number(rawCoins);
      const newBalance = currentCoins + Number(amount);

      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid,
        type: 'topup',
        amount,
        balance: newBalance,
        timestamp: Timestamp.now(),
        metadata
      });
    });

    // Get new balance (safe access)
    const walletDoc = await walletRef.get();
    const newBalance = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;

    res.json({
      success: true,
      amount,
      newBalance,
      transactionId: `topup_${Date.now()}`
    });
  } catch (error) {
    console.error('Topup error:', error);
    res.status(500).json({ success: false, error: 'Failed to topup' });
  }
});

/**
 * POST /wallet/spend
 * Spend coins from user's balance
 */
router.post('/spend', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
      console.error('[WALLET] verifyIdToken failed:', verifyError);
      return res.status(401).json({ success: false, error: 'Invalid auth token' });
    }
    const uid = decodedToken.uid;
    console.log('[WALLET] Authenticated uid:', uid);

    const { amount, metadata = {} } = req.body;

    if (!amount || amount < 1 || amount > 5000) {
      return res.status(400).json({ success: false, error: 'Invalid amount (1-5000)' });
    }

    // Update balance
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    let newBalance;

    await db.runTransaction(async (transaction) => {
      const walletDoc = await transaction.get(walletRef);
      const rawCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
      const currentCoins = isNaN(Number(rawCoins)) ? 0 : Number(rawCoins);

      if (currentCoins < Number(amount)) {
        throw new Error('Insufficient balance');
      }

      newBalance = currentCoins - Number(amount);
      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      const transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid,
        type: 'spend',
        amount,
        balance: newBalance,
        timestamp: Timestamp.now(),
        metadata
      });
    });

    res.json({
      success: true,
      amount,
      newBalance,
      transactionId: `spend_${Date.now()}`
    });
  } catch (error) {
    console.error('Spend error:', error);
    if (error.message === 'Insufficient balance') {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }
    res.status(500).json({ success: false, error: 'Failed to spend' });
  }
});

/**
 * GET /wallet/transactions
 * Get user's transaction history
 */
router.get('/transactions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
      console.error('[WALLET] verifyIdToken failed:', verifyError);
      return res.status(401).json({ success: false, error: 'Invalid auth token' });
    }
    const uid = decodedToken.uid;
    console.log('[WALLET] Authenticated uid:', uid);

    const limit = parseInt(req.query.limit) || 50;
    // Note: Removed offset to avoid Firestore index requirements
    // For pagination, consider cursor-based approach

    const transactionsRef = db.collection('transactions')
      .where('uid', '==', uid);

    const snapshot = await transactionsRef.get();
    const transactions = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
      };
    });

    // Sort in memory since Firestore composite index might not be ready
    transactions.sort((a, b) => b.timestamp - a.timestamp);
    const limitedTransactions = transactions.slice(0, limit);

    res.json({
      success: true,
      transactions: limitedTransactions,
      count: limitedTransactions.length
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transactions' });
  }
});

/**
 * POST /wallet/reward
 * Reward user with coins for watching an ad
 */
router.post('/reward', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (verifyError) {
      console.error('[WALLET] verifyIdToken failed:', verifyError);
      return res.status(401).json({ success: false, error: 'Invalid auth token' });
    }
    const uid = decodedToken.uid;
    console.log('[WALLET] Authenticated uid:', uid);

    let { amount = 10, adId, metadata = {} } = req.body;
    console.log('[WALLET REWARD] Request:', { uid, amount, adId, metadata });

    // Validate amount and metadata
    amount = Number(amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    if (typeof metadata !== 'object' || metadata === null) {
      // Try to parse if it's a JSON string
      try {
        metadata = JSON.parse(metadata || '{}');
      } catch (e) {
        metadata = {};
      }
    }

    // Ensure wallet reference and a timestamp are available
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    const nowTimestamp = Timestamp.now();

    // Validate amount (fixed reward for now)
    if (amount !== 10) {
      return res.status(400).json({ success: false, error: 'Invalid reward amount' });
    }

    // Simple rate limiting: check last reward within 24 hours
    const walletDoc = await walletRef.get();
    const walletData = walletDoc.exists ? walletDoc.data() : {};
    const lastReward = walletData.lastReward ? walletData.lastReward.toDate() : null;
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (lastReward && lastReward > oneDayAgo) {
      return res.status(429).json({ success: false, error: 'Reward already claimed today. Try again tomorrow.' });
    }

    // Update balance and last reward
    console.log('[WALLET REWARD] Running transaction for uid:', uid, 'amount:', amount);
    let transactionRef;
    try {
      transactionRef = db.collection('transactions').doc();
      await db.runTransaction(async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const currentCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
        const newBalance = currentCoins + amount;
        console.log('[WALLET REWARD] Current coins:', currentCoins, 'New balance:', newBalance);

        transaction.set(walletRef, {
          coins: newBalance,
          lastReward: nowTimestamp
        }, { merge: true });

        // Create transaction record
        transaction.set(transactionRef, {
          uid,
          type: 'reward',
          amount,
          balance: newBalance,
          timestamp: nowTimestamp,
          metadata: { adId, ...metadata }
        });
      });
    } catch (txErr) {
      console.error('[WALLET REWARD] Transaction failed:', txErr, txErr.stack);
      return res.status(500).json({ success: false, error: txErr.message || 'Transaction failed' });
    }

    // Get new balance
    const updatedWalletDoc = await walletRef.get();
    const newBalance = updatedWalletDoc.exists ? (updatedWalletDoc.data().coins || 0) : 0;
    console.log('[WALLET REWARD] Updated balance for', uid, '=>', newBalance, 'txId:', transactionRef?.id);

    res.json({
      success: true,
      amount,
      newBalance,
      transactionId: transactionRef?.id || `reward_${Date.now()}`
    });
  } catch (error) {
    console.error('Reward error:', error, error.stack);
    const msg = error && error.message ? error.message : 'Failed to reward';
    // Expose message for easier debugging in development
    if (process.env.NODE_ENV === 'development') {
      return res.status(500).json({ success: false, error: msg, details: error.stack });
    }
    return res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;

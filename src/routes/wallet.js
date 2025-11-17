const express = require('express');
const { getFirestore } = require('firebase-admin/firestore');
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
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

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
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { amount, metadata = {} } = req.body;

    if (!amount || amount < 1 || amount > 1000) {
      return res.status(400).json({ success: false, error: 'Invalid amount (1-1000)' });
    }

    // Update balance
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    await db.runTransaction(async (transaction) => {
      const walletDoc = await transaction.get(walletRef);
      const currentCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
      const newBalance = currentCoins + amount;

      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      const transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid,
        type: 'topup',
        amount,
        balance: newBalance,
        timestamp: new Date(),
        metadata
      });
    });

    // Get new balance
    const walletDoc = await walletRef.get();
    const newBalance = walletDoc.data().coins;

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
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { amount, metadata = {} } = req.body;

    if (!amount || amount < 1 || amount > 5000) {
      return res.status(400).json({ success: false, error: 'Invalid amount (1-5000)' });
    }

    // Update balance
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
    let newBalance;

    await db.runTransaction(async (transaction) => {
      const walletDoc = await transaction.get(walletRef);
      const currentCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;

      if (currentCoins < amount) {
        throw new Error('Insufficient balance');
      }

      newBalance = currentCoins - amount;
      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      const transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid,
        type: 'spend',
        amount,
        balance: newBalance,
        timestamp: new Date(),
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
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const transactionsRef = db.collection('transactions')
      .where('uid', '==', uid)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .offset(offset);

    const snapshot = await transactionsRef.get();
    const transactions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp.toDate()
    }));

    res.json({
      success: true,
      transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get transactions' });
  }
});

module.exports = router;

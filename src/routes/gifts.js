const express = require('express');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const router = express.Router();
const db = getFirestore();

// Import gift catalog from service
const { getGiftCatalog } = require('../utils/giftHelpers');

// ============== GIFTS ROUTES ==============

/**
 * POST /gifts/send
 * Send a gift to another user
 */
router.post('/send', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const senderUid = decodedToken.uid;

    const { receiverUid, roomId, giftId, senderName } = req.body;

    if (!receiverUid || !roomId || !giftId || !senderName) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // Get gift catalog
    const gifts = await getGiftCatalog();
    const gift = gifts.find(g => g.id === giftId);
    if (!gift) {
      return res.status(400).json({ success: false, error: 'Invalid gift ID' });
    }

    // Check sender balance
    const walletRef = db.collection('users').doc(senderUid).collection('wallet').doc('balance');
    const walletDoc = await walletRef.get();
    const rawCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
    const currentCoins = isNaN(Number(rawCoins)) ? 0 : Number(rawCoins);

    if (currentCoins < gift.price) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    // Deduct coins from sender
    const newBalance = currentCoins - gift.price;
    await db.runTransaction(async (transaction) => {
      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      const transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid: senderUid,
        type: 'spend',
        amount: gift.price,
        balance: newBalance,
        timestamp: Timestamp.fromDate(new Date()),
        metadata: { type: 'gift', giftId, receiverUid, roomId }
      });

      // Create gift receipt for receiver
      const receiptRef = db.collection('users').doc(receiverUid).collection('giftReceipts').doc();
      transaction.set(receiptRef, {
        id: receiptRef.id,
        fromUid: senderUid,
        fromName: senderName,
        roomId,
        gift: { id: gift.id, name: gift.name, price: gift.price, icon: gift.icon },
        createdAt: Timestamp.fromDate(new Date()),
        status: 'unread'
      });

      // Create gift message in chat
      const messageRef = db.collection('rooms').doc(roomId).collection('messages').doc();
      transaction.set(messageRef, {
        id: messageRef.id,
        uid: senderUid,
        senderName,
        type: 'gift',
        gift: { id: gift.id, name: gift.name, price: gift.price, icon: gift.icon },
        createdAt: Timestamp.fromDate(new Date()),
        readBy: [],
        status: 'sent'
      });

      // Update room metadata
      const roomRef = db.collection('rooms').doc(roomId);
      transaction.update(roomRef, {
        lastMessage: { 
          type: 'gift',
          gift: { id: gift.id, name: gift.name, price: gift.price, icon: gift.icon },
          createdAt: Timestamp.fromDate(new Date()),
          uid: senderUid,
          status: 'sent'
        },
        updatedAt: Timestamp.fromDate(new Date()),
        [`unreadCounts.${receiverUid}`]: FieldValue.increment(1)
      });
    });

    // Get updated balance
    const updatedWallet = await walletRef.get();
    const finalBalance = updatedWallet.data().coins;

    res.json({
      success: true,
      gift,
      messageId: `gift_${Date.now()}`,
      receiptId: `receipt_${Date.now()}`,
      newBalance: finalBalance
    });
  } catch (error) {
    console.error('Send gift error:', error);
    res.status(500).json({ success: false, error: 'Failed to send gift' });
  }
});

/**
 * GET /gifts/received
 * Get received gifts for the authenticated user
 */
router.get('/received', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { limit = 50, status } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 1000); // Max 1000

    // Get gift receipts
    const receiptsRef = db.collection('users').doc(uid).collection('giftReceipts');
    let query = receiptsRef.orderBy('createdAt', 'desc').limit(limitNum);

    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();
    const gifts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      gifts,
      count: gifts.length
    });
  } catch (error) {
    console.error('Get received gifts error:', error);
    res.status(500).json({ success: false, error: 'Failed to get received gifts' });
  }
});

/**
 * POST /gifts/redeem
 * Redeem a received gift for coins
 */
router.post('/redeem', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { receiptId, rate = 1 } = req.body;

    if (!receiptId) {
      return res.status(400).json({ success: false, error: 'Missing receiptId' });
    }

    const receiptRef = db.collection('users').doc(uid).collection('giftReceipts').doc(receiptId);
    const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');

    let redeemValue;

    await db.runTransaction(async (transaction) => {
      // Get receipt
      const receiptDoc = await transaction.get(receiptRef);
      if (!receiptDoc.exists) {
        throw new Error('Receipt not found');
      }

      const receipt = receiptDoc.data();
      if (!receipt.gift || typeof receipt.gift.price !== 'number') {
        throw new Error('Invalid gift data');
      }

      if (receipt.redeemed) {
        throw new Error('Already redeemed');
      }

      redeemValue = Math.floor(receipt.gift.price * rate);
      if (isNaN(redeemValue) || redeemValue <= 0) {
        throw new Error('Invalid redeem value');
      }

      // Get wallet
      const walletDoc = await transaction.get(walletRef);
      const rawCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
      const currentCoins = isNaN(Number(rawCoins)) ? 0 : Number(rawCoins);
      const newBalance = currentCoins + redeemValue;

      // Update receipt
      transaction.update(receiptRef, {
        redeemed: true,
        redeemedAt: Timestamp.fromDate(new Date()),
        redeemValue
      });

      // Update wallet
      transaction.set(walletRef, { coins: newBalance }, { merge: true });

      // Create transaction record
      const transactionRef = db.collection('transactions').doc();
      transaction.set(transactionRef, {
        uid,
        type: 'topup',
        amount: redeemValue,
        balance: newBalance,
        timestamp: Timestamp.fromDate(new Date()),
        metadata: { type: 'gift_redeem', receiptId, giftId: receipt.gift.id }
      });
    });

    // Get updated balance
    const updatedWallet = await walletRef.get();
    const rawUpdated = updatedWallet.exists ? updatedWallet.data().coins || 0 : 0;
    const finalBalance = isNaN(Number(rawUpdated)) ? 0 : Number(rawUpdated);

    res.json({
      success: true,
      redeemValue,
      newBalance: finalBalance
    });
  } catch (error) {
    console.error('Redeem gift error:', error.message, error.stack);
    if (error.message === 'Receipt not found') {
      return res.status(404).json({ success: false, error: 'Receipt not found' });
    }
    if (error.message === 'Invalid gift data' || error.message === 'Already redeemed' || error.message === 'Invalid redeem value') {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Failed to redeem gift' });
  }
});

/**
 * GET /gifts/catalog
 * Get gift catalog
 */
router.get('/catalog', async (req, res) => {
  try {
    const gifts = await getGiftCatalog();
    res.json({ success: true, gifts, count: gifts.length });
  } catch (error) {
    console.error('Get gift catalog error:', error);
    res.status(500).json({ success: false, error: 'Failed to get gift catalog' });
  }
});

module.exports = router;

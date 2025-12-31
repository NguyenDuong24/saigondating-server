const express = require('express');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const router = express.Router();
const db = getFirestore();

// ============== SHOP ROUTES ==============

/**
 * GET /shop/items
 * Get all shop items
 */
router.get('/items', async (req, res) => {
    try {
        const itemsRef = db.collection('shop_items');
        const snapshot = await itemsRef.where('active', '==', true).get();

        const items = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // If no items, return empty list (Admin should create items)
        if (items.length === 0) {
            return res.json({ success: true, items: [], count: 0 });
        }

        res.json({
            success: true,
            items,
            count: items.length
        });
    } catch (error) {
        console.error('Get shop items error:', error);
        res.status(500).json({ success: false, error: 'Failed to get shop items' });
    }
});

/**
 * GET /shop/items/:itemId
 * Get a specific shop item
 */
router.get('/items/:itemId', async (req, res) => {
    try {
        const { itemId } = req.params;
        const itemDoc = await db.collection('shop_items').doc(itemId).get();

        if (!itemDoc.exists) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        res.json({
            success: true,
            item: { id: itemDoc.id, ...itemDoc.data() }
        });
    } catch (error) {
        console.error('Get shop item error:', error);
        res.status(500).json({ success: false, error: 'Failed to get shop item' });
    }
});

/**
 * POST /shop/purchase
 * Purchase an item from the shop
 */
router.post('/purchase', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await getAuth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        const { itemId } = req.body;
        if (!itemId) {
            return res.status(400).json({ success: false, error: 'Missing itemId' });
        }

        // Get item details
        const itemDoc = await db.collection('shop_items').doc(itemId).get();

        if (!itemDoc.exists) {
            return res.status(404).json({ success: false, error: 'Item not found' });
        }

        const item = itemDoc.data();
        if (!item.active) {
            return res.status(400).json({ success: false, error: 'Item is inactive' });
        }

        const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
        const myItemsRef = db.collection('users').doc(uid).collection('purchased_items').doc(itemId);

        let newBalance;
        await db.runTransaction(async (transaction) => {
            // Check if already owned (only for non-consumable items)
            const consumableItems = ['super_like_10', 'super_like_pack', 'boost_24h', 'profile_boost'];
            if (!consumableItems.includes(itemId)) {
                const myItemDoc = await transaction.get(myItemsRef);
                if (myItemDoc.exists) {
                    throw new Error('ALREADY_OWNED');
                }
            }

            // Check balance
            const walletDoc = await transaction.get(walletRef);
            const walletData = walletDoc.exists ? walletDoc.data() : {};
            const currencyType = item.currencyType || 'coins';
            const currentBalance = walletData[currencyType] || 0;

            if (currentBalance < item.price) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            newBalance = currentBalance - item.price;

            // Deduct from correct currency
            transaction.set(walletRef, { [currencyType]: newBalance }, { merge: true });

            // Add to my items
            transaction.set(myItemsRef, {
                itemId,
                itemName: item.name,
                price: item.price,
                purchasedAt: Timestamp.now(),
            }, { merge: true });

            // Apply item effects
            const userRef = db.collection('users').doc(uid);
            if (itemId === 'vip_1m' || itemId === 'vip_badge') {
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + thirtyDays);
                transaction.update(userRef, {
                    isPro: true,
                    proExpiresAt: Timestamp.fromDate(expiresAt),
                    vipBadge: true
                });
            } else if (itemId === 'vip_3m') {
                const ninetyDays = 90 * 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + ninetyDays);
                transaction.update(userRef, {
                    isPro: true,
                    proExpiresAt: Timestamp.fromDate(expiresAt),
                    vipBadge: true
                });
            } else if (itemId === 'boost_24h' || itemId === 'profile_boost') {
                const twentyFourHours = 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + twentyFourHours);
                transaction.update(userRef, {
                    boostedUntil: Timestamp.fromDate(expiresAt)
                });
            } else if (itemId === 'super_like_10' || itemId === 'super_like_pack') {
                transaction.update(userRef, {
                    superLikes: FieldValue.increment(10)
                });
            } else if (itemId === 'incognito_mode') {
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + thirtyDays);
                transaction.update(userRef, {
                    incognitoUntil: Timestamp.fromDate(expiresAt)
                });
            } else if (itemId === 'unlock_visitors') {
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + thirtyDays);
                transaction.update(userRef, {
                    canSeeVisitorsUntil: Timestamp.fromDate(expiresAt)
                });
            } else if (itemId === 'read_receipts') {
                transaction.update(userRef, {
                    hasReadReceiptsFeature: true
                });
            } else if (itemId === 'rich_badge') {
                transaction.update(userRef, {
                    hasRichBadge: true
                });
            } else if (item.category === 'avatar_frame') {
                // Handle avatar frame purchase
                // Set the frame as active and add to owned frames
                transaction.update(userRef, {
                    activeFrame: item.frameType,
                    [`frames.${item.frameType}`]: true
                });
            }

            // Create transaction record
            const transactionRef = db.collection('transactions').doc();
            transaction.set(transactionRef, {
                uid,
                type: 'spend',
                currencyType: item.currencyType || 'coins',
                amount: item.price,
                balance: newBalance,
                timestamp: Timestamp.now(),
                metadata: { type: 'shop_purchase', itemId, itemName: item.name }
            });
        });

        res.json({
            success: true,
            itemId,
            itemName: item.name,
            price: item.price,
            newBalance
        });
    } catch (error) {
        console.error('Purchase item error:', error);
        if (error.message === 'INSUFFICIENT_FUNDS') {
            return res.status(400).json({ success: false, error: 'Insufficient funds', code: 'INSUFFICIENT_FUNDS' });
        }
        if (error.message === 'ALREADY_OWNED') {
            return res.status(400).json({ success: false, error: 'You already own this item', code: 'ALREADY_OWNED' });
        }
        res.status(500).json({ success: false, error: 'Failed to purchase item' });
    }
});

/**
 * GET /shop/my-items
 * Get user's purchased items
 */
router.get('/my-items', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await getAuth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        const myItemsRef = db.collection('users').doc(uid).collection('purchased_items');
        const snapshot = await myItemsRef.orderBy('purchasedAt', 'desc').get();

        const items = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            purchasedAt: doc.data().purchasedAt ? doc.data().purchasedAt.toDate() : new Date()
        }));

        res.json({
            success: true,
            items,
            count: items.length
        });
    } catch (error) {
        console.error('Get my items error:', error);
        res.status(500).json({ success: false, error: 'Failed to get my items' });
    }
});

module.exports = router;

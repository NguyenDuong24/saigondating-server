const express = require('express');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const authMiddleware = require('../middleware/auth');

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
router.post('/purchase', authMiddleware, async (req, res) => {
    try {
        const uid = req.user.uid;

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
                category: item.category || 'other',
                frameType: item.frameType || null,
                emoji: item.emoji || '',
                description: item.description || ''
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
router.get('/my-items', authMiddleware, async (req, res) => {
    try {
        const uid = req.user.uid;

        const myItemsRef = db.collection('users').doc(uid).collection('purchased_items');
        const snapshot = await myItemsRef.orderBy('purchasedAt', 'desc').get();

        const purchasedItems = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            purchasedAt: doc.data().purchasedAt ? doc.data().purchasedAt.toDate() : new Date()
        }));

        // Fetch full item details to ensure we have category, frameType, etc.
        const itemsWithDetails = await Promise.all(purchasedItems.map(async (purchasedItem) => {
            try {
                // If the purchased item already has category/frameType, use it
                if (purchasedItem.category && (purchasedItem.category !== 'avatar_frame' || purchasedItem.frameType)) {
                    return purchasedItem;
                }

                // Otherwise fetch from shop_items
                const shopItemDoc = await db.collection('shop_items').doc(purchasedItem.itemId).get();
                if (shopItemDoc.exists) {
                    const shopItemData = shopItemDoc.data();
                    return {
                        ...purchasedItem,
                        category: shopItemData.category,
                        frameType: shopItemData.frameType,
                        emoji: shopItemData.emoji,
                        description: shopItemData.description,
                        // Keep purchased price/name as historical record, but merge other metadata
                    };
                }
                return purchasedItem;
            } catch (err) {
                console.warn(`Failed to fetch details for item ${purchasedItem.itemId}:`, err);
                return purchasedItem;
            }
        }));

        res.json({
            success: true,
            items: itemsWithDetails,
            count: itemsWithDetails.length
        });
    } catch (error) {
        console.error('Get my items error:', error);
        res.status(500).json({ success: false, error: 'Failed to get my items' });
    }
});

/**
 * POST /shop/equip-frame
 * Equip an owned avatar frame
 */
router.post('/equip-frame', authMiddleware, async (req, res) => {
    try {
        const { uid } = req.user;
        const { frameType, itemId } = req.body;

        if (!frameType && !itemId) {
            return res.status(400).json({ success: false, error: 'Frame type or Item ID is required' });
        }

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        let targetFrameType = frameType;

        // If itemId is provided, verify ownership via purchased_items (more robust)
        if (itemId) {
            const purchasedItemDoc = await userRef.collection('purchased_items').doc(itemId).get();
            if (!purchasedItemDoc.exists) {
                return res.status(403).json({
                    success: false,
                    error: 'You do not own this item',
                    code: 'ITEM_NOT_OWNED'
                });
            }

            // Fetch the current frameType from the shop item to ensure it's up to date
            const shopItemDoc = await db.collection('shop_items').doc(itemId).get();
            if (shopItemDoc.exists) {
                targetFrameType = shopItemDoc.data().frameType;
            }

            if (!targetFrameType) {
                return res.status(400).json({ success: false, error: 'This item is not a frame' });
            }
        } else {
            // Fallback to checking the frames map directly
            const userData = userDoc.data();
            const ownedFrames = userData.frames || {};
            if (!ownedFrames[frameType]) {
                return res.status(403).json({
                    success: false,
                    error: 'You do not own this frame',
                    code: 'FRAME_NOT_OWNED'
                });
            }
        }

        // Equip the frame and ensure it's marked as owned in the frames map
        await userRef.update({
            activeFrame: targetFrameType,
            [`frames.${targetFrameType}`]: true,
            updatedAt: Timestamp.now()
        });

        res.json({
            success: true,
            activeFrame: targetFrameType,
            message: 'Frame equipped successfully'
        });
    } catch (error) {
        console.error('Equip frame error:', error);
        res.status(500).json({ success: false, error: 'Failed to equip frame' });
    }
});

module.exports = router;

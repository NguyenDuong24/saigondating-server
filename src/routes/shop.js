const express = require('express');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
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

        // If no items, return some default ones for demo/initial setup
        if (items.length === 0) {
            const defaultItems = [
                { id: 'vip_badge', name: 'Huy hiệu VIP', price: 500, emoji: '💎', description: 'Hiển thị huy hiệu VIP trên hồ sơ và mở khóa tính năng Pro trong 30 ngày' },
                { id: 'extra_likes', name: 'Thêm 50 lượt thích', price: 200, emoji: '❤️', description: 'Tăng giới hạn lượt thích hàng ngày của bạn' },
                { id: 'profile_boost', name: 'Đẩy hồ sơ', price: 300, emoji: '🚀', description: 'Hồ sơ của bạn sẽ được ưu tiên hiển thị trong 24h' },
                { id: 'custom_theme', name: 'Giao diện đặc biệt', price: 1000, emoji: '🎨', description: 'Mở khóa giao diện tùy chỉnh cho ứng dụng' },
                { id: 'incognito_mode', name: 'Chế độ ẩn danh', price: 800, emoji: '🕵️', description: 'Xem hồ sơ người khác mà không để lại dấu vết' },
                { id: 'super_like_pack', name: 'Gói 10 Super Like', price: 400, emoji: '⭐', description: 'Gây ấn tượng mạnh với người bạn thích' },
            ];
            return res.json({ success: true, items: defaultItems, count: defaultItems.length });
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
        let item;

        if (!itemDoc.exists) {
            // Check if it's one of the default items
            const defaultItems = {
                'vip_badge': { name: 'Huy hiệu VIP', price: 500 },
                'extra_likes': { name: 'Thêm 50 lượt thích', price: 200 },
                'profile_boost': { name: 'Đẩy hồ sơ', price: 300 },
                'custom_theme': { name: 'Giao diện đặc biệt', price: 1000 },
                'incognito_mode': { name: 'Chế độ ẩn danh', price: 800 },
                'super_like_pack': { name: 'Gói 10 Super Like', price: 400 },
            };
            item = defaultItems[itemId];
            if (!item) {
                return res.status(404).json({ success: false, error: 'Item not found' });
            }
        } else {
            item = itemDoc.data();
            if (!item.active) {
                return res.status(400).json({ success: false, error: 'Item is inactive' });
            }
        }

        const walletRef = db.collection('users').doc(uid).collection('wallet').doc('balance');
        const myItemsRef = db.collection('users').doc(uid).collection('purchased_items').doc(itemId);

        let newBalance;
        await db.runTransaction(async (transaction) => {
            // Check if already owned
            const myItemDoc = await transaction.get(myItemsRef);
            if (myItemDoc.exists) {
                throw new Error('ALREADY_OWNED');
            }

            // Check balance
            const walletDoc = await transaction.get(walletRef);
            const currentCoins = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;

            if (currentCoins < item.price) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            newBalance = currentCoins - item.price;

            // Deduct coins
            transaction.set(walletRef, { coins: newBalance }, { merge: true });

            // Add to my items
            transaction.set(myItemsRef, {
                itemId,
                itemName: item.name,
                price: item.price,
                purchasedAt: Timestamp.now(),
            });

            // Apply item effects
            const userRef = db.collection('users').doc(uid);
            if (itemId === 'vip_badge') {
                const thirtyDays = 30 * 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + thirtyDays);
                transaction.update(userRef, {
                    isPro: true,
                    proExpiresAt: Timestamp.fromDate(expiresAt),
                    vipBadge: true
                });
            } else if (itemId === 'profile_boost') {
                const twentyFourHours = 24 * 60 * 60 * 1000;
                const expiresAt = new Date(Date.now() + twentyFourHours);
                transaction.update(userRef, {
                    boostedUntil: Timestamp.fromDate(expiresAt)
                });
            }

            // Create transaction record
            const transactionRef = db.collection('transactions').doc();
            transaction.set(transactionRef, {
                uid,
                type: 'spend',
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

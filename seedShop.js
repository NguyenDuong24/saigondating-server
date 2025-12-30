const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const SHOP_ITEMS = [
    {
        id: 'vip_1m',
        name: 'VIP 1 Month',
        price: 500,
        currencyType: 'coins',
        emoji: '👑',
        description: 'Unlock premium features for 30 days. See who likes you, unlimited swipes, and more!',
        category: 'subscription',
        active: true
    },
    {
        id: 'vip_3m',
        name: 'VIP 3 Months',
        price: 1200,
        currencyType: 'coins',
        emoji: '👑',
        description: 'Save 20% with the 3-month plan. Best value for new users.',
        category: 'subscription',
        active: true
    },
    {
        id: 'vip_1y',
        name: 'VIP 1 Year',
        price: 4000,
        currencyType: 'coins',
        emoji: '👑',
        description: 'Ultimate VIP experience for a whole year. Save 33%!',
        category: 'subscription',
        active: true
    },
    {
        id: 'boost_profile',
        name: 'Boost Profile',
        price: 100,
        currencyType: 'banhMi',
        emoji: '🚀',
        description: 'Be the top profile in your area for 30 minutes. Get up to 10x more views!',
        category: 'consumable',
        active: true
    },
    {
        id: 'super_like_pack',
        name: '5 Super Likes',
        price: 50,
        currencyType: 'coins',
        emoji: '⭐',
        description: 'Stand out from the crowd. Super Likes let them know you are really interested.',
        category: 'consumable',
        active: true
    },
    {
        id: 'frame_gold',
        name: 'Golden Frame',
        price: 200,
        currencyType: 'banhMi',
        emoji: '🖼️',
        description: 'Add a shiny golden frame to your avatar.',
        category: 'cosmetic',
        active: true
    }
];

async function seedShop() {
    console.log('🌱 Seeding shop items...');
    const batch = db.batch();

    for (const item of SHOP_ITEMS) {
        const ref = db.collection('shop_items').doc(item.id);
        batch.set(ref, {
            ...item,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Prepared: ${item.name}`);
    }

    await batch.commit();
    console.log('✅ Shop items seeded successfully!');
    process.exit(0);
}

seedShop().catch(console.error);

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

const GIFT_ITEMS = [
    {
        id: 'rose',
        name: 'Rose',
        price: 10,
        currencyType: 'coins',
        icon: '🌹',
        active: true
    },
    {
        id: 'coffee',
        name: 'Coffee',
        price: 20,
        currencyType: 'coins',
        icon: '☕',
        active: true
    },
    {
        id: 'chocolate',
        name: 'Chocolate',
        price: 50,
        currencyType: 'coins',
        icon: '🍫',
        active: true
    },
    {
        id: 'teddy_bear',
        name: 'Teddy Bear',
        price: 100,
        currencyType: 'coins',
        icon: '🧸',
        active: true
    },
    {
        id: 'perfume',
        name: 'Perfume',
        price: 500,
        currencyType: 'coins',
        icon: '🧴',
        active: true
    },
    {
        id: 'diamond_ring',
        name: 'Diamond Ring',
        price: 1000,
        currencyType: 'coins',
        icon: '💍',
        active: true
    },
    {
        id: 'luxury_car',
        name: 'Luxury Car',
        price: 5000,
        currencyType: 'coins',
        icon: '🏎️',
        active: true
    },
    {
        id: 'private_jet',
        name: 'Private Jet',
        price: 10000,
        currencyType: 'coins',
        icon: '✈️',
        active: true
    },
    {
        id: 'banh_mi_special',
        name: 'Special Banh Mi',
        price: 50,
        currencyType: 'banhMi',
        icon: '🥖',
        active: true
    }
];

async function seedGifts() {
    console.log('🎁 Seeding gift items...');
    const batch = db.batch();

    for (const item of GIFT_ITEMS) {
        const ref = db.collection('gifts').doc(item.id);
        batch.set(ref, {
            ...item,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Prepared: ${item.name}`);
    }

    await batch.commit();
    console.log('✅ Gift items seeded successfully!');
    process.exit(0);
}

seedGifts().catch(console.error);

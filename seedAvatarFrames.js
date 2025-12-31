const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const AVATAR_FRAMES = [
    {
        id: 'frame_gold',
        name: 'Golden Frame',
        price: 200,
        currencyType: 'banhMi',
        emoji: '🖼️',
        description: 'Luxurious golden frame for your avatar. Show off your premium status!',
        category: 'avatar_frame',
        frameType: 'gold',
        active: true
    },
    {
        id: 'frame_silver',
        name: 'Silver Frame',
        price: 100,
        currencyType: 'banhMi',
        emoji: '⭕',
        description: 'Elegant silver frame that adds a touch of class to your profile.',
        category: 'avatar_frame',
        frameType: 'silver',
        active: true
    },
    {
        id: 'frame_diamond',
        name: 'Diamond Frame',
        price: 500,
        currencyType: 'coins',
        emoji: '💎',
        description: 'Exclusive diamond-studded frame with sparkling effects. Ultra rare!',
        category: 'avatar_frame',
        frameType: 'diamond',
        active: true
    },
    {
        id: 'frame_rainbow',
        name: 'Rainbow Frame',
        price: 300,
        currencyType: 'banhMi',
        emoji: '🌈',
        description: 'Colorful animated rainbow frame that cycles through vibrant colors.',
        category: 'avatar_frame',
        frameType: 'rainbow',
        active: true
    },
    {
        id: 'frame_fire',
        name: 'Fire Frame',
        price: 400,
        currencyType: 'coins',
        emoji: '🔥',
        description: 'Blazing fire effect frame with animated flames. Hot!',
        category: 'avatar_frame',
        frameType: 'fire',
        active: true
    },
    {
        id: 'frame_neon',
        name: 'Neon Frame',
        price: 250,
        currencyType: 'banhMi',
        emoji: '✨',
        description: 'Glowing neon frame with pulsing light effects.',
        category: 'avatar_frame',
        frameType: 'neon',
        active: true
    },
    {
        id: 'frame_heart',
        name: 'Heart Frame',
        price: 150,
        currencyType: 'banhMi',
        emoji: '💖',
        description: 'Romantic heart-shaped frame perfect for showing love.',
        category: 'avatar_frame',
        frameType: 'heart',
        active: true
    },
    {
        id: 'frame_star',
        name: 'Star Frame',
        price: 180,
        currencyType: 'banhMi',
        emoji: '⭐',
        description: 'Shining star frame that makes you stand out from the crowd.',
        category: 'avatar_frame',
        frameType: 'star',
        active: true
    }
];

async function seedAvatarFrames() {
    console.log('🖼️  Seeding avatar frame items...');
    const batch = db.batch();

    for (const item of AVATAR_FRAMES) {
        const ref = db.collection('shop_items').doc(item.id);
        batch.set(ref, {
            ...item,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`✅ Prepared: ${item.name} (${item.price} ${item.currencyType})`);
    }

    await batch.commit();
    console.log('🎉 Avatar frame items seeded successfully!');
    console.log(`📊 Total frames added: ${AVATAR_FRAMES.length}`);
    process.exit(0);
}

seedAvatarFrames().catch((error) => {
    console.error('❌ Error seeding avatar frames:', error);
    process.exit(1);
});

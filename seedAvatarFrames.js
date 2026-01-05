const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const AVATAR_FRAMES = [
    {
        id: 'frame_money',
        name: 'Khung Yêu Tiền',
        price: 500,
        currencyType: 'coins',
        emoji: '💰',
        description: 'Khung vàng sang trọng với tiền và kim cương. Dành cho đại gia!',
        category: 'avatar_frame',
        frameType: 'money',
        active: true
    },
    {
        id: 'frame_ocean',
        name: 'Khung Biển',
        price: 300,
        currencyType: 'banhMi',
        emoji: '🌊',
        description: 'Khung sóng biển mát lạnh với sao biển và vỏ sò.',
        category: 'avatar_frame',
        frameType: 'ocean',
        active: true
    },
    {
        id: 'frame_devil',
        name: 'Khung Ác Quỷ',
        price: 666,
        currencyType: 'coins',
        emoji: '😈',
        description: 'Khung ác quỷ đầy quyền lực với cánh dơi và lửa đỏ.',
        category: 'avatar_frame',
        frameType: 'devil',
        active: true
    },
    {
        id: 'frame_ufo',
        name: 'Khung UFO',
        price: 450,
        currencyType: 'coins',
        emoji: '🛸',
        description: 'Khung đĩa bay huyền bí từ không gian xa xôi.',
        category: 'avatar_frame',
        frameType: 'ufo',
        active: true
    },
    {
        id: 'frame_elegant',
        name: 'Khung Lịch Lãm',
        price: 250,
        currencyType: 'banhMi',
        emoji: '🌹',
        description: 'Khung quý ông lịch lãm với hoa hồng và nơ đen.',
        category: 'avatar_frame',
        frameType: 'elegant',
        active: true
    },
    {
        id: 'frame_japan',
        name: 'Khung Nhật Bản',
        price: 350,
        currencyType: 'banhMi',
        emoji: '🌸',
        description: 'Khung hoa anh đào và lồng đèn truyền thống Nhật Bản.',
        category: 'avatar_frame',
        frameType: 'japan',
        active: true
    },
    {
        id: 'frame_gamer',
        name: 'Khung Gamer',
        price: 400,
        currencyType: 'coins',
        emoji: '🎮',
        description: 'Khung phong cách gaming với đèn neon và nút bấm.',
        category: 'avatar_frame',
        frameType: 'gamer',
        active: true
    },
    {
        id: 'frame_astronaut',
        name: 'Khung Phi Hành Gia',
        price: 550,
        currencyType: 'coins',
        emoji: '👨‍🚀',
        description: 'Khung phi hành gia khám phá các vì sao tinh tú.',
        category: 'avatar_frame',
        frameType: 'astronaut',
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

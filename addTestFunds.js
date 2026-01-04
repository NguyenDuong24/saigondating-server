const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

/**
 * Add test funds to a user
 * Usage: node addTestFunds.js USER_EMAIL 10000 5000
 */
async function addTestFunds(email, coins = 10000, banhMi = 5000) {
    try {
        console.log(`💰 Adding test funds for: ${email}`);

        // Find user by email
        const usersSnapshot = await db.collection('users')
            .where('email', '==', email)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            console.error('❌ User not found with email:', email);
            return;
        }

        const userDoc = usersSnapshot.docs[0];
        const uid = userDoc.id;

        // Get or create wallet
        const walletRef = db.collection('wallets').doc(uid);
        const walletDoc = await walletRef.get();

        const currentCoins = walletDoc.exists ? (walletDoc.data().coins || 0) : 0;
        const currentBanhMi = walletDoc.exists ? (walletDoc.data().banhMi || 0) : 0;

        // Add funds
        await walletRef.set({
            uid,
            coins: currentCoins + coins,
            banhMi: currentBanhMi + banhMi,
            updatedAt: admin.firestore.Timestamp.now()
        }, { merge: true });

        console.log('✅ Funds added successfully!');
        console.log(`   Coins: ${currentCoins} → ${currentCoins + coins} (+${coins})`);
        console.log(`   Bánh mì: ${currentBanhMi} → ${currentBanhMi + banhMi} (+${banhMi})`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error adding funds:', error);
        process.exit(1);
    }
}

// Get arguments
const email = process.argv[2];
const coins = process.argv[3] !== undefined ? parseInt(process.argv[3]) : 10000;
const banhMi = process.argv[4] !== undefined ? parseInt(process.argv[4]) : 5000;

if (!email) {
    console.error('Usage: node addTestFunds.js USER_EMAIL [COINS] [BANHMI]');
    console.error('Example: node addTestFunds.js user@example.com 10000 5000');
    process.exit(1);
}

addTestFunds(email, coins, banhMi);

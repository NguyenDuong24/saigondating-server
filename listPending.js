const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function listPendingTransactions() {
    console.log('🔍 Listing pending MoMo transactions...');
    const snapshot = await db.collection('momoTransactions')
        .where('status', '==', 'pending')
        .limit(10)
        .get();

    if (snapshot.empty) {
        console.log('No pending transactions found.');
        return;
    }

    snapshot.forEach(doc => {
        const data = doc.data();
        console.log(`- ID: ${doc.id}, User: ${data.userId}, Amount: ${data.amount}, Coins: ${data.coinAmount}, Created: ${data.createdAt.toDate()}`);
    });
}

listPendingTransactions().catch(console.error);

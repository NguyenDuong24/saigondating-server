const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function checkBalance(userId) {
    const walletRef = db.collection('users').doc(userId).collection('wallet').doc('balance');
    const doc = await walletRef.get();

    if (!doc.exists) {
        console.log(`User ${userId} has no wallet balance document.`);
        return;
    }

    console.log(`💰 Current balance for user ${userId}:`, doc.data());
}

checkBalance('KtERsqi8q0Prlm82pODRY4iYV4E2').catch(console.error);

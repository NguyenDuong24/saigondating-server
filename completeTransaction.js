const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function completeTransaction(orderId) {
    console.log(`🚀 Completing transaction: ${orderId}`);
    const transactionRef = db.collection('momoTransactions').doc(orderId);
    const transactionDoc = await transactionRef.get();

    if (!transactionDoc.exists) {
        console.error('❌ Transaction not found');
        return;
    }

    const transaction = transactionDoc.data();
    if (transaction.status !== 'pending') {
        console.log(`⚠️ Transaction is already ${transaction.status}`);
        return;
    }

    // 1. Update transaction status
    await transactionRef.update({
        status: 'success',
        momoTransId: 'MOCK_' + Date.now(),
        completedAt: admin.firestore.Timestamp.now(),
        isMock: true
    });

    // 2. Add coins to user wallet
    const userId = transaction.userId;
    const coinAmount = transaction.coinAmount;

    console.log(`💰 Adding ${coinAmount} coins to user ${userId}`);

    const walletRef = db.collection('users').doc(userId).collection('wallet').doc('balance');

    await db.runTransaction(async (t) => {
        const walletDoc = await t.get(walletRef);
        const currentCoins = walletDoc.exists ? walletDoc.data().coins || 0 : 0;
        t.set(walletRef, {
            coins: currentCoins + coinAmount,
            updatedAt: admin.firestore.Timestamp.now()
        }, { merge: true });
    });

    // 3. Log transaction
    await db.collection('transactions').add({
        uid: userId,
        type: 'momo_topup',
        amount: coinAmount,
        momoOrderId: orderId,
        timestamp: admin.firestore.Timestamp.now(),
        isMock: true
    });

    console.log('✅ Transaction completed successfully!');
}

async function findAndComplete() {
    console.log('🔍 Searching for pending transactions with 650 coins...');
    const snapshot = await db.collection('momoTransactions')
        .where('status', '==', 'pending')
        .where('coinAmount', '==', 650)
        .get();

    if (snapshot.empty) {
        console.log('No matching pending transactions found.');
        // List all pending to see what's there
        const allPending = await db.collection('momoTransactions')
            .where('status', '==', 'pending')
            .limit(5)
            .get();

        if (!allPending.empty) {
            console.log('Other pending transactions:');
            allPending.forEach(doc => {
                console.log(`- ID: ${doc.id}, User: ${doc.data().userId}, Coins: ${doc.data().coinAmount}`);
            });
        }
        return;
    }

    for (const doc of snapshot.docs) {
        await completeTransaction(doc.id);
    }
}

findAndComplete().catch(console.error);

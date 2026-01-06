const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function listItems() {
    const snapshot = await db.collection('shop_items').get();
    snapshot.forEach(doc => {
        console.log(`ID: ${doc.id}, Name: ${doc.data().name}, Category: ${doc.data().category}`);
    });
    process.exit(0);
}

listItems().catch(err => {
    console.error(err);
    process.exit(1);
});

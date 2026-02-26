const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function checkCollections() {
    const hotspotsLower = await db.collection('hotspots').count().get();
    const hotspotsCamel = await db.collection('hotSpots').count().get();

    console.log('Collection "hotspots" (lowercase):', hotspotsLower.data().count);
    console.log('Collection "hotSpots" (camelCase):', hotspotsCamel.data().count);
}

checkCollections().catch(console.error);

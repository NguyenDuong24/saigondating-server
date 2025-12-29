/**
 * Migration Script: Add likesCount field to existing posts
 * 
 * This script updates all existing posts in Firestore to add the likesCount field
 * based on the current likes array length.
 * 
 * Run this ONCE to update existing data.
 */

const admin = require('firebase-admin');
const serviceAccount = require('./path/to/serviceAccountKey.json'); // Update this path

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migratePosts() {
    console.log('🚀 Starting migration: Adding likesCount to posts...');

    const postsRef = db.collection('posts');
    const PAGE_SIZE = 500;
    let lastDoc = null;
    let totalUpdated = 0;
    let hasMore = true;

    while (hasMore) {
        try {
            // Build query
            let query = postsRef.orderBy('timestamp', 'desc').limit(PAGE_SIZE);

            if (lastDoc) {
                query = query.startAfter(lastDoc);
            }

            const snapshot = await query.get();

            if (snapshot.empty) {
                hasMore = false;
                break;
            }

            console.log(`📦 Processing batch of ${snapshot.docs.length} posts...`);

            //  Update posts in batch
            const batch = db.batch();
            let batchCount = 0;

            for (const doc of snapshot.docs) {
                const data = doc.data();
                const likes = Array.isArray(data.likes) ? data.likes : [];
                const likesCount = likes.length;

                // Update document with likesCount
                batch.update(doc.ref, { likesCount });
                batchCount++;
                totalUpdated++;

                // Firestore batch limit is 500, commit if reaching limit
                if (batchCount >= 500) {
                    await batch.commit();
                    console.log(`✅ Committed batch of ${batchCount} updates`);
                    batchCount = 0;
                }
            }

            // Commit remaining updates
            if (batchCount > 0) {
                await batch.commit();
                console.log(`✅ Committed batch of ${batchCount} updates`);
            }

            // Update pagination
            lastDoc = snapshot.docs[snapshot.docs.length - 1];
            hasMore = snapshot.docs.length === PAGE_SIZE;

            console.log(`✨ Progress: ${totalUpdated} posts updated so far...`);

        } catch (error) {
            console.error('❌ Error during migration:', error);
            throw error;
        }
    }

    console.log(`\n🎉 Migration complete! Total posts updated: ${totalUpdated}`);
}

// Run migration
migratePosts()
    .then(() => {
        console.log('✅ Script finished successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Script failed:', error);
        process.exit(1);
    });

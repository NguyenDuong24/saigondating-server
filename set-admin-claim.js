#!/usr/bin/env node

/**
 * Script to grant admin privileges to a Firebase user using Custom Claims
 * 
 * Usage:
 *   node set-admin-claim.js <email>
 * 
 * Example:
 *   node set-admin-claim.js admin@chappat.com
 */

require('dotenv').config();
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`,
        universe_domain: "googleapis.com"
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

async function setAdminClaim(email) {
    try {
        console.log(`🔍 Looking for user with email: ${email}`);

        // Get user by email
        const user = await admin.auth().getUserByEmail(email);
        console.log(`✅ Found user: ${user.uid}`);

        // Set custom claim
        await admin.auth().setCustomUserClaims(user.uid, { admin: true });
        console.log(`✅ Admin claim set successfully for ${email}`);

        // Verify the claim was set
        const updatedUser = await admin.auth().getUser(user.uid);
        console.log(`📋 Custom claims:`, updatedUser.customClaims);

        console.log(`\n✨ Success! User ${email} is now an admin.`);
        console.log(`⚠️  Note: The user must sign out and sign in again for the claim to take effect.`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);

        if (error.code === 'auth/user-not-found') {
            console.log(`\n💡 User with email ${email} does not exist.`);
            console.log(`   Please create the user first in Firebase Console:`);
            console.log(`   https://console.firebase.google.com/project/dating-app-1bb49/authentication/users`);
        }

        process.exit(1);
    }
}

// Get email from command line argument
const email = process.argv[2];

if (!email) {
    console.error('❌ Usage: node set-admin-claim.js <email>');
    console.error('   Example: node set-admin-claim.js admin@chappat.com');
    process.exit(1);
}

// Validate email format
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
    console.error('❌ Invalid email format:', email);
    process.exit(1);
}

setAdminClaim(email);

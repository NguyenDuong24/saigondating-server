/**
 * Script thiết lập AdMob config trong Firestore
 * 
 * Chạy: node scripts/setup-ads-config.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const admin = require('firebase-admin');

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

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function setup() {
  const adSettings = {
    rewardAmount: 10,          // Xu thưởng mỗi lần xem ad
    dailyLimit: 5,              // Giới hạn xem ad mỗi ngày
    enabled: true,
    interstitialEnabled: true,
    interstitialShowRate: 0.25,  // 25% cơ hội show ad
    minSecondsBetweenInterstitials: 180,  // 3 phút giữa 2 lần
    androidInterstitialAdUnitId: 'ca-app-pub-9844251118980104/5558909825',
    iosInterstitialAdUnitId: 'ca-app-pub-9844251118980104/8913926524',
    // 👇 Khi nào tạo Banner & Rewarded thì thêm vào:
    // androidBannerAdUnitId: 'ca-app-pub-9844251118980104/XXXXXXXXXX',
    // iosBannerAdUnitId: 'ca-app-pub-9844251118980104/XXXXXXXXXX',
    // androidRewardedAdUnitId: 'ca-app-pub-9844251118980104/XXXXXXXXXX',
    // iosRewardedAdUnitId: 'ca-app-pub-9844251118980104/XXXXXXXXXX',
  };

  await db.collection('system_config').doc('ad_settings').set(adSettings, { merge: true });
  console.log('✅ Ad settings saved to Firestore!');
  console.log(JSON.stringify(adSettings, null, 2));
  process.exit(0);
}

setup().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

const GIFTS_COLLECTION = 'gifts';

// Fallback gifts if Firestore is empty
const fallbackGifts = [
  { id: 'banh-mi-thit', name: 'Bánh mì thịt', price: 20, currencyType: 'banhMi', icon: '🥖', active: true },
  { id: 'tra-sua', name: 'Trà sữa', price: 15, currencyType: 'banhMi', icon: '🧋', active: true },
  { id: 'hoa-hong', name: 'Hoa hồng', price: 10, currencyType: 'banhMi', icon: '🌹', active: true },
  { id: 'cafe-sua', name: 'Cà phê sữa', price: 12, currencyType: 'banhMi', icon: '☕️', active: true },
];

/**
 * Get gift catalog from Firestore or fallback
 */
async function getGiftCatalog() {
  try {
    const giftsRef = db.collection(GIFTS_COLLECTION);
    const snapshot = await giftsRef.where('active', '==', true).get();

    if (!snapshot.empty) {
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    }

    // Return fallback if no gifts in Firestore
    return fallbackGifts;
  } catch (error) {
    console.error('Error getting gift catalog:', error);
    return fallbackGifts;
  }
}

module.exports = { getGiftCatalog };

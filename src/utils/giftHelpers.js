const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

const GIFTS_COLLECTION = 'gifts';

// Fallback gifts if Firestore is empty
const fallbackGifts = [
  // Bánh mì gifts (Common/Rare)
  { id: 'hoa-hong', name: 'Hoa hồng', price: 10, currencyType: 'banhMi', icon: '🌹', active: true },
  { id: 'cafe-sua', name: 'Cà phê sữa', price: 12, currencyType: 'banhMi', icon: '☕️', active: true },
  { id: 'tra-sua', name: 'Trà sữa', price: 15, currencyType: 'banhMi', icon: '🧋', active: true },
  { id: 'banh-mi-thit', name: 'Bánh mì thịt', price: 20, currencyType: 'banhMi', icon: '🥖', active: true },
  { id: 'bia-sai-gon', name: 'Bia Sài Gòn', price: 25, currencyType: 'banhMi', icon: '🍺', active: true },
  { id: 'pho-bo', name: 'Phở bò', price: 30, currencyType: 'banhMi', icon: '🍜', active: true },
  { id: 'meo-may-man', name: 'Mèo may mắn', price: 50, currencyType: 'banhMi', icon: '🐱', active: true },
  { id: 'gau-bong', name: 'Gấu bông', price: 80, currencyType: 'banhMi', icon: '🧸', active: true },

  // Coin gifts (Special/Epic/Legendary)
  { id: 'kim-cuong', name: 'Kim cương', price: 100, currencyType: 'coins', icon: '💎', active: true },
  { id: 'vong-co', name: 'Vòng cổ ngọc trai', price: 500, currencyType: 'coins', icon: '📿', active: true },
  { id: 'nhan-kim-cuong', name: 'Nhẫn kim cương', price: 1000, currencyType: 'coins', icon: '💍', active: true },
  { id: 'sieu-xe', name: 'Siêu xe', price: 2000, currencyType: 'coins', icon: '🏎️', active: true },
  { id: 'du-thuyen', name: 'Du thuyền', price: 3000, currencyType: 'coins', icon: '🛥️', active: true },
  { id: 'lau-dai', name: 'Lâu đài', price: 5000, currencyType: 'coins', icon: '🏰', active: true },
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

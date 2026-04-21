function badRequest(res, message) {
  return res.status(400).json({ success: false, error: message });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateWalletTopup(req, res, next) {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
    return badRequest(res, 'Invalid amount (1-1000)');
  }
  req.body.amount = amount;
  next();
}

function validateWalletSpend(req, res, next) {
  const amount = Number(req.body?.amount);
  const currencyType = req.body?.currencyType ?? 'banhMi';
  if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
    return badRequest(res, 'Invalid amount (1-5000)');
  }
  if (!['coins', 'banhMi'].includes(currencyType)) {
    return badRequest(res, 'Invalid currency type');
  }
  req.body.amount = amount;
  req.body.currencyType = currencyType;
  next();
}

function validateWalletReward(req, res, next) {
  const amount = Number(req.body?.amount ?? 10);
  const adId = req.body?.adId;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
    return badRequest(res, 'Invalid reward amount');
  }
  if (!isNonEmptyString(adId) || String(adId).length > 128) {
    return badRequest(res, 'Invalid adId');
  }
  req.body.amount = amount;
  req.body.adId = String(adId).trim();
  next();
}

function validateGiftSend(req, res, next) {
  const { receiverUid, roomId, giftId, senderName } = req.body || {};
  if (!isNonEmptyString(receiverUid) || !isNonEmptyString(roomId) || !isNonEmptyString(giftId) || !isNonEmptyString(senderName)) {
    return badRequest(res, 'Missing required fields');
  }
  req.body.receiverUid = String(receiverUid).trim();
  req.body.roomId = String(roomId).trim();
  req.body.giftId = String(giftId).trim();
  req.body.senderName = String(senderName).trim().slice(0, 60);
  next();
}

function validateGiftRedeem(req, res, next) {
  const receiptId = req.body?.receiptId;
  const rate = Number(req.body?.rate ?? 1);
  if (!isNonEmptyString(receiptId)) {
    return badRequest(res, 'Missing receiptId');
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > 5) {
    return badRequest(res, 'Invalid rate');
  }
  req.body.receiptId = String(receiptId).trim();
  req.body.rate = rate;
  next();
}

function validateGiftReward(req, res, next) {
  const adId = req.body?.adId;
  if (!isNonEmptyString(adId) || String(adId).length > 128) {
    return badRequest(res, 'Ad ID required');
  }
  req.body.adId = String(adId).trim();
  next();
}

module.exports = {
  validateWalletTopup,
  validateWalletSpend,
  validateWalletReward,
  validateGiftSend,
  validateGiftRedeem,
  validateGiftReward,
};

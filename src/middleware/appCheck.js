const admin = require('firebase-admin');

const DEFAULT_EXEMPT_PATHS = [
  '/api/admin',
  '/api/momo/callback',
  '/api/vietqr/webhook',
  '/api/vietqr/sms-received',
  '/api/vietqr/check-pending',
];

function getExemptPaths() {
  return (process.env.APP_CHECK_EXEMPT_PATHS || DEFAULT_EXEMPT_PATHS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appCheckMiddleware(req, res, next) {
  const required = String(process.env.REQUIRE_FIREBASE_APP_CHECK || '').toLowerCase() === 'true';
  if (!required || req.method === 'OPTIONS') {
    return next();
  }

  const originalUrl = req.originalUrl || req.url || '';
  if (getExemptPaths().some((prefix) => originalUrl.startsWith(prefix))) {
    return next();
  }

  const appCheckToken = req.header('X-Firebase-AppCheck');
  if (!appCheckToken) {
    return res.status(401).json({
      success: false,
      code: 'APP_CHECK_REQUIRED',
      error: 'Firebase App Check token is required',
    });
  }

  try {
    req.appCheck = await admin.appCheck().verifyToken(appCheckToken);
    return next();
  } catch (error) {
    console.error('[APP_CHECK] Invalid token:', error);
    return res.status(401).json({
      success: false,
      code: 'APP_CHECK_FAILED',
      error: 'Invalid Firebase App Check token',
    });
  }
}

module.exports = appCheckMiddleware;

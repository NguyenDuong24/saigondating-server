const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Initialize Firebase Admin
const admin = require('firebase-admin');

// Use environment variables for Firebase credentials
const requiredEnvVars = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_CLIENT_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Environment variable ${envVar} is required but not set`);
  }
}

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

const app = express();
// Trust proxy is required when running behind a proxy like Render/Heroku
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients and same-origin server-to-server calls
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
}));

const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);
// Strict limiter for expensive AI and sensitive payment routes
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/ai-matchmaker', strictLimiter);
app.use('/api/vietqr/check-pending', strictLimiter);
// Logging middleware
app.use(morgan('combined'));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// Import routes
const walletRoutes = require('./routes/wallet');
const giftRoutes = require('./routes/gifts');
const shopRoutes = require('./routes/shop');
const userRoutes = require('./routes/user');
const videosdkRoutes = require('./routes/videosdk');
const momoRoutes = require('./routes/momo');
const vietqrRoutes = require('./routes/vietqr');
const iapRoutes = require('./routes/iap');
const adminRoutes = require('./routes/admin');
const adminManagementRoutes = require('./routes/adminManagement');
const aiMatchmakerRoutes = require('./routes/aiMatchmaker');

// Import middlewares
const authMiddleware = require('./middleware/auth');
const adminAuth = require('./middleware/adminAuth');
const appCheckMiddleware = require('./middleware/appCheck');

// Register routes
app.use('/api', appCheckMiddleware);
app.use('/api/wallet', walletRoutes);
app.use('/api/gifts', giftRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/user', userRoutes);
app.use('/api/videosdk', videosdkRoutes);
app.use('/api/momo', momoRoutes);
app.use('/api/vietqr', vietqrRoutes);
app.use('/api/iap', iapRoutes);
app.use('/api/ai-matchmaker', aiMatchmakerRoutes);

// Admin routes (protected with both auth and admin check)
app.use('/api/admin', authMiddleware, adminAuth, adminRoutes);
app.use('/api/admin/management', authMiddleware, adminAuth, adminManagementRoutes);

// Health check endpoint - optimized for monitoring
// No authentication, no database, no external calls
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'saigon-match-api',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`
  });
});

// Error handling middleware
app.use((err, req, res, _next) => {
  console.error('[GLOBAL ERROR]', err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Saigon Dating Server is running on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
  console.log(`🌐 API available at http://localhost:${PORT}/api`);
});

// ─── Stale Online Status Cleanup ────────────────────────────
// When users force-kill the app, they can't update isOnline to false.
// This cron job detects stale online users and marks them offline.
// Heartbeat (client): writes lastActive every 60s while in foreground.
// Stale threshold: 3 minutes without heartbeat → considered offline.

const STALE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const STALE_THRESHOLD_MS = 3 * 60 * 1000;        // 3 minutes without heartbeat

async function cleanupStaleOnlineUsers() {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const usersRef = admin.firestore().collection('users');
    const snapshot = await usersRef
      .where('isOnline', '==', true)
      .where('lastActive', '<', cutoff)
      .limit(500)
      .get();

    if (snapshot.empty) return;

    const batch = admin.firestore().batch();
    const now = new Date();
    snapshot.forEach(doc => {
      // Defensive: double-check isOnline is still true (could have been updated since query)
      if (doc.data()?.isOnline === true) {
        batch.update(doc.ref, {
          isOnline: false,
          lastActive: admin.firestore.Timestamp.fromDate(now),
        });
      }
    });

    await batch.commit();
    console.log(`🧹 [Presence Cleanup] Marked ${snapshot.size} stale users offline`);
  } catch (error) {
    console.error('🧹 [Presence Cleanup] Error:', error.message);
  }
}

// Run immediately on startup, then on interval
cleanupStaleOnlineUsers();
setInterval(cleanupStaleOnlineUsers, STALE_CLEANUP_INTERVAL_MS);

module.exports = app;

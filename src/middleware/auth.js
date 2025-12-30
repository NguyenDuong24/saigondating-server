/**
 * Authentication Middleware
 * Verifies Firebase ID token and attaches user info to request
 */

const admin = require('firebase-admin');

async function authMiddleware(req, res, next) {
    try {
        // Get token from Authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Unauthorized',
                code: 'AUTH_REQUIRED',
                message: 'No authentication token provided'
            });
        }

        const token = authHeader.split('Bearer ')[1];

        // Verify the token
        const decodedToken = await admin.auth().verifyIdToken(token);

        // Attach user info to request
        req.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            emailVerified: decodedToken.email_verified
        };

        next();
    } catch (error) {
        console.error('Auth middleware error:', error);

        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({
                error: 'Token expired',
                code: 'TOKEN_EXPIRED',
                message: 'Authentication token has expired'
            });
        }

        return res.status(401).json({
            error: 'Unauthorized',
            code: 'AUTH_FAILED',
            message: 'Invalid authentication token'
        });
    }
}

module.exports = authMiddleware;

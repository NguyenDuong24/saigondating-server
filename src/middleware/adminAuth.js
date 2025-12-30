/**
 * Admin Authentication Middleware
 * Verifies that the authenticated user has admin custom claims
 */

const admin = require('firebase-admin');

/**
 * Middleware to check if user has admin privileges via Firebase custom claims
 * Must be used after authentication middleware
 */
async function adminAuth(req, res, next) {
    try {
        // Check if user was authenticated (should be set by auth middleware)
        if (!req.user || !req.user.uid) {
            return res.status(401).json({
                error: 'Unauthorized',
                code: 'AUTH_REQUIRED',
                message: 'Authentication required'
            });
        }

        // Get fresh token data to check custom claims
        const user = await admin.auth().getUser(req.user.uid);

        // Check if user has admin claim
        if (!user.customClaims || user.customClaims.admin !== true) {
            console.log(`❌ Admin access denied for user ${req.user.uid} (${req.user.email || 'no email'})`);
            return res.status(403).json({
                error: 'Forbidden',
                code: 'ADMIN_REQUIRED',
                message: 'Admin privileges required'
            });
        }

        console.log(`✅ Admin access granted for user ${req.user.uid} (${req.user.email || 'no email'})`);

        // User is admin, proceed
        next();
    } catch (error) {
        console.error('Admin auth middleware error:', error);
        return res.status(500).json({
            error: 'Internal Server Error',
            code: 'SERVER_ERROR',
            message: 'Error verifying admin status'
        });
    }
}

module.exports = adminAuth;

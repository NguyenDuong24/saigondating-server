const express = require('express');
const jwt = require('jsonwebtoken');
const { getAuth } = require('firebase-admin/auth');
const router = express.Router();

/**
 * GET /videosdk/token
 * Generate a new VideoSDK token for the authenticated user
 */
router.get('/token', async (req, res) => {
    try {
        // 1) Verify Firebase Authentication
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        const idToken = authHeader.split('Bearer ')[1];
        let decodedToken;
        try {
            decodedToken = await getAuth().verifyIdToken(idToken);
        } catch (verifyError) {
            console.error('[VIDEOSDK] verifyIdToken failed:', verifyError);
            return res.status(401).json({ success: false, error: 'Invalid auth token' });
        }

        // 2) Check server secrets
        const API_KEY = process.env.VIDEOSDK_API_KEY;
        const SECRET_KEY = process.env.VIDEOSDK_SECRET_KEY;

        if (!API_KEY || !SECRET_KEY) {
            console.error('VideoSDK keys not configured in server environment');
            return res.status(500).json({ success: false, error: 'Server configuration error' });
        }

        // 3) Generate scoped token
        const options = {
            expiresIn: '120m',
            algorithm: 'HS256'
        };

        const payload = {
            apikey: API_KEY,
            permissions: ['allow_join', 'allow_mod'],
            version: 2,
            roles: ['CRAWLER'],
            uid: decodedToken.uid,
        };

        const token = jwt.sign(payload, SECRET_KEY, options);

        res.json({
            success: true,
            token: token
        });

    } catch (error) {
        console.error('VideoSDK token error:', error);
        res.status(500).json({ success: false, error: 'Failed to generate token' });
    }
});

module.exports = router;

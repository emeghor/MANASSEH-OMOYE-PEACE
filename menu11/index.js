/**
 * FIREBASE CLOUD FUNCTIONS BACKEND (functions/index.js)
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const ADMIN_SECRET_KEY = "YOUR_ADMIN_SECRET_KEY"; 
const PROJECT_ID = "YOUR_PROJECT_ID";             

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'YOUR_EMAIL@gmail.com',
        pass: 'YOUR_GMAIL_APP_PASSWORD'
    }
});

exports.approveOrder = functions.https.onRequest((req, res) => {
    // Explicit CORS Preflight Handling
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { orderId, email, bookId, adminKey } = req.body;

    if (adminKey !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: "Unauthorized: Invalid admin secret key." });
    }

    return (async () => {
        try {
            const downloadToken = crypto.randomBytes(24).toString('hex');
            const expiresAt = Date.now() + (24 * 60 * 60 * 1000); 

            await db.collection('download_tokens').doc(downloadToken).set({
                bookId: bookId,
                used: false,
                expiresAt: expiresAt,
                email: email,
                createdAt: Date.now()
            });

            await db.collection('orders').doc(orderId).update({ 
                status: 'APPROVED',
                approvedAt: Date.now()
            });

            const downloadUrl = `https://us-central1-${PROJECT_ID}.cloudfunctions.net/downloadBook?token=${downloadToken}`;

            await transporter.sendMail({
                from: '"Author Store" <YOUR_EMAIL@gmail.com>',
                to: email,
                subject: 'Payment Confirmed - Book Download Link',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                        <h2>Payment Verified!</h2>
                        <p>Thank you for your bank transfer. Your order for <strong>${bookId}</strong> has been confirmed.</p>
                        <p>Click the button below to download your ebook:</p>
                        <a href="${downloadUrl}" style="background-color: #2563eb; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; margin: 15px 0;">Download Book Now</a>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                        <p style="color: #dc2626; font-size: 0.9em;"><strong>SECURITY NOTICE:</strong></p>
                        <ul style="color: #666; font-size: 0.9em;">
                            <li>This download link will expire in <strong>24 hours</strong>.</li>
                            <li>This link is restricted to <strong>ONE single download attempt</strong>.</li>
                        </ul>
                    </div>
                `
            });

            return res.status(200).json({ success: true });
        } catch (err) {
            console.error("Approve order error:", err);
            return res.status(500).json({ error: err.toString() });
        }
    })();
});

exports.downloadBook = functions.https.onRequest(async (req, res) => {
    const token = req.query.token;

    if (!token) {
        return res.status(400).send("<h1>400 Bad Request</h1><p>Missing security token parameter.</p>");
    }

    try {
        const tokenRef = db.collection('download_tokens').doc(token);
        const tokenDoc = await tokenRef.get();

        if (!tokenDoc.exists) {
            return res.status(403).send("<h1>403 Access Denied</h1><p>Invalid or expired token link.</p>");
        }

        const data = tokenDoc.data();

        if (Date.now() > data.expiresAt) {
            return res.status(403).send(`
                <div style="font-family: sans-serif; text-align: center; padding: 30px;">
                    <h1 style="color: #dc2626;">Link Expired</h1>
                    <p>This download link has exceeded its 24-hour validity window.</p>
                </div>
            `);
        }

        if (data.used) {
            return res.status(403).send(`
                <div style="font-family: sans-serif; text-align: center; padding: 30px;">
                    <h1 style="color: #dc2626;">Link Already Used</h1>
                    <p>This download link has already been accessed. Each link allows only 1 download attempt.</p>
                </div>
            `);
        }

        await tokenRef.update({ used: true, accessedAt: Date.now() });

        const bucket = admin.storage().bucket();
        const file = bucket.file(`books/${data.bookId}.pdf`);

        // Fix: Pass explicit Date object for signed URL expiration
        const [signedUrl] = await file.getSignedUrl({
            action: 'read',
            expires: new Date(Date.now() + 60 * 1000)
        });

        return res.redirect(signedUrl);
    } catch (err) {
        console.error("Download error:", err);
        return res.status(500).send("<h1>500 Internal Server Error</h1>");
    }
});
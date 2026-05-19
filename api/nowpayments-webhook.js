import admin from 'firebase-admin';
import crypto from 'crypto';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
}

const db = admin.firestore();

export default async function handler(req, res) {

    if (req.method !== 'POST') {
        return res.status(200).json({ ok: true, message: 'NowPayments webhook is live!' });
    }

    try {
        const payment = req.body;

        // Verify the payment is genuine using your IPN secret
        const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
        const receivedHmac = req.headers['x-nowpayments-sig'] || '';

        if (ipnSecret && receivedHmac) {
            const sortedBody = JSON.stringify(sortObject(payment));
            const expectedHmac = crypto
                .createHmac('sha512', ipnSecret)
                .update(sortedBody)
                .digest('hex');

            if (expectedHmac !== receivedHmac) {
                console.log('Invalid HMAC signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        const paymentStatus = payment.payment_status || '';
        const paymentId = String(payment.payment_id || '');
        const amountPaid = parseFloat(payment.price_amount || payment.pay_amount || 0);

        // Only process finished/confirmed payments
        if (paymentStatus !== 'finished' && paymentStatus !== 'confirmed') {
            return res.status(200).json({ received: true, status: 'ignored', payment_status: paymentStatus });
        }

        if (!paymentId || amountPaid <= 0) {
            return res.status(200).json({ received: true, error: 'Invalid payment data' });
        }

        // Prevent double processing
        const alreadyDone = await db.collection('depositProofs')
            .where('paymentId', '==', paymentId)
            .where('status', '==', 'approved')
            .limit(1)
            .get();

        if (!alreadyDone.empty) {
            return res.status(200).json({ received: true, status: 'already_processed' });
        }

        // Find the user's submitted deposit proof
        const proofSnap = await db.collection('depositProofs')
            .where('paymentId', '==', paymentId)
            .where('status', '==', 'pending')
            .limit(1)
            .get();

        if (proofSnap.empty) {
            // No proof found — save for admin to review manually
            await db.collection('auto_deposits').add({
                paymentId: paymentId,
                amount: amountPaid,
                paymentData: payment,
                status: 'needs_review',
                source: 'nowpayments',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            await sendTelegram(
`⚠️ <b>NowPayments — No Proof Found</b>
💵 Amount: $${amountPaid}
🆔 Payment ID: ${paymentId}
⚠️ User submitted no proof — check manually`
            );

            return res.status(200).json({ received: true, status: 'no_proof_found' });
        }

        const proofDoc = proofSnap.docs[0];
        const proofData = proofDoc.data();
        const userUid = proofData.uid;

        if (!userUid) {
            return res.status(200).json({ error: 'No user UID found' });
        }

        const userRef = db.collection('users').doc(userUid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(200).json({ error: 'User not found in database' });
        }

        const userData = userSnap.data();
        const batch = db.batch();

        // 1. Credit user balance
        batch.update(userRef, {
            balance: admin.firestore.FieldValue.increment(amountPaid)
        });

        // 2. Mark proof as approved
        batch.update(proofDoc.ref, {
            status: 'approved',
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            approvedBy: 'nowpayments_auto',
            autoApproved: true
        });

        // 3. Add transaction record
        const txRef = db.collection('transactions').doc();
        batch.set(txRef, {
            uid: userUid,
            type: 'Deposit',
            amount: amountPaid,
            status: 'approved',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            metadata: {
                paymentId: paymentId,
                method: 'Crypto (Auto)',
                userEmail: userData.email || '',
                autoApproved: true
            }
        });

        // 4. Referral commission
        const referrerUid = userData.referredBy || null;
        if (referrerUid) {
            const rates = { Bronze: 0.05, Silver: 0.08, Gold: 0.12, Royal: 0.15 };
            const rate = rates[userData.partnerLevel || 'Bronze'] || 0.05;
            const commission = parseFloat((amountPaid * rate).toFixed(2));

            if (commission > 0) {
                batch.update(db.collection('users').doc(referrerUid), {
                    balance: admin.firestore.FieldValue.increment(commission)
                });

                batch.set(db.collection('transactions').doc(), {
                    uid: referrerUid,
                    type: 'Referral Bonus',
                    amount: commission,
                    status: 'approved',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    metadata: {
                        fromUser: userUid,
                        fromDeposit: amountPaid,
                        commissionRate: `${rate * 100}%`,
                        autoApproved: true
                    }
                });
            }
        }

        await batch.commit();

        await sendTelegram(
`✅ <b>Auto Deposit Approved!</b>
👤 User: ${userData.firstName || 'Unknown'}
📧 Email: ${userData.email || 'N/A'}
💵 Amount: $${amountPaid}
🆔 Payment ID: ${paymentId}
🤖 Auto-approved by NowPayments webhook`
        );

        return res.status(200).json({ success: true, credited: amountPaid });

    } catch(err) {
        console.error('Webhook error:', err);
        return res.status(500).json({ error: err.message });
    }
}

// Helper: sort object keys for HMAC verification
function sortObject(obj) {
    return Object.keys(obj).sort().reduce((result, key) => {
        result[key] = obj[key] && typeof obj[key] === 'object' ? sortObject(obj[key]) : obj[key];
        return result;
    }, {});
}

// Helper: send Telegram message
async function sendTelegram(text) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML'
            })
        });
    } catch(e) {
        console.error('Telegram error:', e);
    }
}

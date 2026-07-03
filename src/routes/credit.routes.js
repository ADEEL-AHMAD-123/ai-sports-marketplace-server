/**
 * credit.routes.js — Credit wallet + Stripe endpoints
 *
 * ⚠️ /webhook uses raw body — must be registered BEFORE express.json().
 *    See app.js.
 *
 * Payment-related endpoints have their own rate limits — attackers who
 * grab a stolen JWT shouldn't be able to hammer Stripe checkout creation
 * or refund requests.
 */
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const c         = require('../controllers/credit.controller');
const { protect, requireVerifiedEmail } = require('../middleware/auth.middleware');
const { validateCreditPurchase, validatePagination } = require('../middleware/validate.middleware');

// Tight per-user limits on payment-mutating endpoints. Keyed by user ID
// so multiple users on the same NAT don't share a bucket.
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute
  max: 10,                 // 10 checkout / refund requests per minute per user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || req.ip,
  message: { success: false, message: 'Too many payment requests — please wait a moment.' },
});

// Stripe → us. Public. Signature is the only auth.
router.post('/webhook', c.stripeWebhook);

// Everything else requires an authenticated user.
router.use(protect);

router.get ('/balance',       c.getBalance);
router.get ('/packs',         c.getCreditPacks);
router.get ('/summary',       c.getSummary);
router.get ('/transactions',        validatePagination, c.getTransactions);
router.get ('/transactions/:txId',  c.getTransactionById);

router.post('/checkout',      paymentLimiter, requireVerifiedEmail, validateCreditPurchase, c.createCheckout);
router.post('/portal',        paymentLimiter, c.createPortal);
router.post('/refund/:txId',  paymentLimiter, c.requestRefund);

module.exports = router;

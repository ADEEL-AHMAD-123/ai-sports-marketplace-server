/**
 * credit.routes.js — Credit wallet and Stripe payment routes
 *
 * ⚠️  IMPORTANT: The /webhook route MUST use raw body parsing.
 *     It is registered BEFORE express.json() in app.js.
 *     See app.js for the special raw body setup.
 */
const express = require('express');
const router = express.Router();
const creditController = require('../controllers/credit.controller');
const { protect } = require('../middleware/auth.middleware');
const { validateCreditPurchase, validatePagination } = require('../middleware/validate.middleware');

// ── Stripe Webhook — PUBLIC (Stripe calls this, not the user) ─────────────────
// Raw body required for Stripe signature verification — handled in app.js
// This route is intentionally BEFORE the protect middleware
router.post('/webhook', creditController.stripeWebhook);

// ── All other credit routes require authentication ────────────────────────────
router.use(protect);

router.get('/balance',           creditController.getBalance);
router.get('/packs',             creditController.getCreditPacks);
router.post('/checkout',         validateCreditPurchase, creditController.createCheckout);
router.get('/transactions',      validatePagination, creditController.getTransactions);

module.exports = router;
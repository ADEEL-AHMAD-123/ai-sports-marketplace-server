/**
 * credit.controller.js — Credit wallet and Stripe payment endpoints
 *
 * Handles:
 *  GET  /api/credits/balance          — Get current credit balance
 *  GET  /api/credits/packs            — List available credit packs
 *  POST /api/credits/checkout         — Create Stripe checkout session
 *  POST /api/credits/webhook          — Stripe webhook (CREDIT GRANTING HAPPENS HERE)
 *  GET  /api/credits/transactions     — Get transaction history
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const CreditService = require('../services/CreditService');
const { CREDIT_PACKS, HTTP_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// ─── Get Balance ───────────────────────────────────────────────────────────────

/**
 * GET /api/credits/balance
 */
const getBalance = async (req, res, next) => {
  try {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      credits: req.user.credits,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Credit Packs ──────────────────────────────────────────────────────────

/**
 * GET /api/credits/packs
 * Returns available credit packs without exposing Stripe price IDs.
 */
const getCreditPacks = (req, res) => {
  const packs = CreditService.getCreditPacks();
  res.status(HTTP_STATUS.OK).json({ success: true, packs });
};

// ─── Create Checkout Session ───────────────────────────────────────────────────

/**
 * POST /api/credits/checkout
 * Creates a Stripe hosted checkout session and returns the redirect URL.
 *
 * Body: { packId }
 */
const createCheckout = async (req, res, next) => {
  try {
    const { packId } = req.body;

    // Find the pack by our internal ID and get the Stripe priceId
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      throw new AppError('Invalid credit pack selection.', HTTP_STATUS.BAD_REQUEST);
    }

    if (!pack.priceId) {
      throw new AppError(
        'This credit pack is not yet configured. Please contact support.',
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );
    }

    const origin = req.headers.origin || `http://localhost:3000`;

    const { url, sessionId } = await CreditService.createCheckoutSession({
      priceId: pack.priceId,
      user: req.user,
      successUrl: `${origin}/wallet?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/wallet?purchase=cancelled`,
    });

    logger.info('💳 [CreditController] Checkout session created', {
      userId: req.user._id,
      packId,
      credits: pack.credits,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      url,
      sessionId,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Stripe Webhook ────────────────────────────────────────────────────────────

/**
 * POST /api/credits/webhook
 *
 * ⚠️  CRITICAL: This is where credits are ACTUALLY granted.
 * Frontend redirects are NOT reliable — this webhook is the source of truth.
 *
 * Stripe signature verification prevents fake webhook events.
 * Raw body is required (must use express.raw() for this route — see app.js).
 */
const stripeWebhook = async (req, res, next) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    logger.warn('⚠️  [CreditController] Webhook received without Stripe signature');
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: 'Missing Stripe signature',
    });
  }

  let event;

  try {
    // Verify the webhook came from Stripe (not a spoofed request)
    // req.body must be the RAW buffer (not parsed JSON) for this to work
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.warn('⚠️  [CreditController] Stripe webhook signature verification failed', {
      error: err.message,
      ip: req.ip,
    });
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: `Webhook signature verification failed: ${err.message}`,
    });
  }

  logger.info('🔔 [CreditController] Stripe webhook received', {
    eventType: event.type,
    eventId: event.id,
  });

  try {
    await CreditService.handleStripeWebhook(event);

    // Stripe requires a 2xx response quickly to acknowledge receipt
    // If we return a non-2xx, Stripe will retry the webhook
    res.status(HTTP_STATUS.OK).json({ received: true });
  } catch (err) {
    logger.error('❌ [CreditController] Webhook processing failed', {
      eventType: event.type,
      error: err.message,
    });
    // Still return 200 to prevent Stripe from retrying for our internal errors
    // Log for manual investigation
    res.status(HTTP_STATUS.OK).json({ received: true, error: 'Processing error — logged for review' });
  }
};

// ─── Transaction History ───────────────────────────────────────────────────────

/**
 * GET /api/credits/transactions?page=1&limit=20
 */
const getTransactions = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await CreditService.getTransactionHistory({
      userId: req.user._id,
      page,
      limit,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getBalance, getCreditPacks, createCheckout, stripeWebhook, getTransactions };
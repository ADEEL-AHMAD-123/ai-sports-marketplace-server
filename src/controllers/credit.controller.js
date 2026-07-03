/**
 * credit.controller.js — Credit wallet and Stripe payment endpoints
 *
 * Handles:
 *  GET  /api/credits/balance          — Current credit balance
 *  GET  /api/credits/packs            — Available credit packs
 *  POST /api/credits/checkout         — Create Stripe checkout session
 *  POST /api/credits/webhook          — Stripe webhook (SOURCE OF TRUTH for grants)
 *  GET  /api/credits/transactions     — Paginated transaction history
 *  GET  /api/credits/summary          — Lifetime spend + credit stats
 *  POST /api/credits/refund/:txId     — Self-serve refund request
 *  POST /api/credits/portal           — Create Stripe Billing Portal session
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const CreditService = require('../services/CreditService');
const { HTTP_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// Small helper: map a service-thrown error code to a friendly HTTP response.
const codeToStatus = {
  INVALID_PACK:        HTTP_STATUS.BAD_REQUEST,
  PACK_NOT_CONFIGURED: HTTP_STATUS.SERVICE_UNAVAILABLE,
  CHARGEBACK_LOCKED:   HTTP_STATUS.FORBIDDEN,
  PURCHASE_NOT_FOUND:  HTTP_STATUS.NOT_FOUND,
  ALREADY_REFUNDED:    HTTP_STATUS.CONFLICT,
  OUTSIDE_WINDOW:      HTTP_STATUS.FORBIDDEN,
  USED_AFTER_PURCHASE: HTTP_STATUS.FORBIDDEN,
  PARTIAL_SPEND:       HTTP_STATUS.FORBIDDEN,
};

// ─── Balance ───────────────────────────────────────────────────────────────
const getBalance = async (req, res, next) => {
  try {
    res.status(HTTP_STATUS.OK).json({ success: true, credits: req.user.credits });
  } catch (err) { next(err); }
};

// ─── Available packs ──────────────────────────────────────────────────────
const getCreditPacks = (req, res) => {
  res.status(HTTP_STATUS.OK).json({ success: true, packs: CreditService.getCreditPacks() });
};

// ─── Create checkout session ──────────────────────────────────────────────
const createCheckout = async (req, res, next) => {
  try {
    const { packId } = req.body;
    if (!packId || typeof packId !== 'string') {
      throw new AppError('Missing packId in request body.', HTTP_STATUS.BAD_REQUEST);
    }

    // Success/cancel URLs constructed from the frontend origin the request
    // came from — supports multiple domains (edgeai.bet, staging, localhost).
    const origin = req.headers.origin || process.env.FRONTEND_URL || 'https://edgeai.bet';

    const { url, sessionId } = await CreditService.createCheckoutSession({
      packId,
      user: req.user,
      successUrl: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${origin}/billing/cancel`,
    });

    logger.info('💳 Checkout session URL generated', { userId: req.user._id, packId });
    res.status(HTTP_STATUS.OK).json({ success: true, url, sessionId });
  } catch (err) {
    if (err.code && codeToStatus[err.code]) {
      return next(new AppError(err.message, codeToStatus[err.code]));
    }
    next(err);
  }
};

// ─── Stripe webhook ────────────────────────────────────────────────────────
//
// Public route. Signature verification is the only auth. Raw body is
// required (see app.js — registered BEFORE express.json()).
const stripeWebhook = async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    logger.warn('⚠️ Webhook received without Stripe signature');
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false, message: 'Missing Stripe signature',
    });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('❌ STRIPE_WEBHOOK_SECRET not configured — refusing to process');
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      success: false, message: 'Webhook not configured',
    });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    logger.warn('⚠️ Stripe webhook signature verification failed', {
      error: err.message, ip: req.ip,
    });
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false, message: `Signature verification failed: ${err.message}`,
    });
  }

  try {
    await CreditService.handleStripeWebhook(event);
    // Stripe requires 2xx quickly to consider the event delivered.
    res.status(HTTP_STATUS.OK).json({ received: true });
  } catch (err) {
    logger.error('❌ Webhook handler failed', {
      eventType: event.type, error: err.message, stack: err.stack,
    });
    // Return 200 anyway so Stripe doesn't retry — we've logged it and
    // will investigate. Retrying wouldn't help for a code bug.
    res.status(HTTP_STATUS.OK).json({ received: true, error: 'internal_processing_error' });
  }
};

// ─── Transaction history ─────────────────────────────────────────────────
const getTransactions = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const type  = req.query.type || null;

    const result = await CreditService.getTransactionHistory({
      userId: req.user._id, page, limit, type,
    });
    res.status(HTTP_STATUS.OK).json({ success: true, ...result });
  } catch (err) { next(err); }
};

// ─── Single transaction detail ────────────────────────────────────────────
const getTransactionById = async (req, res, next) => {
  try {
    const { txId } = req.params;
    if (!txId || !/^[a-f0-9]{24}$/i.test(txId)) {
      throw new AppError('Invalid transaction ID.', HTTP_STATUS.BAD_REQUEST);
    }
    const tx = await CreditService.getTransactionById({
      userId: req.user._id,
      transactionId: txId,
    });
    if (!tx) {
      throw new AppError('Transaction not found.', HTTP_STATUS.NOT_FOUND);
    }
    res.status(HTTP_STATUS.OK).json({ success: true, transaction: tx });
  } catch (err) { next(err); }
};

// ─── Spend summary ────────────────────────────────────────────────────────
const getSummary = async (req, res, next) => {
  try {
    const summary = await CreditService.getSpendSummary(req.user._id);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      credits: req.user.credits,
      summary,
    });
  } catch (err) { next(err); }
};

// ─── Self-serve refund ────────────────────────────────────────────────────
const requestRefund = async (req, res, next) => {
  try {
    const { txId } = req.params;
    if (!txId) {
      throw new AppError('Missing transaction ID.', HTTP_STATUS.BAD_REQUEST);
    }
    const refund = await CreditService.requestSelfServeRefund({
      user: req.user, purchaseTransactionId: txId,
    });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Refund initiated. Credits will be reversed within a few minutes.',
      refundId: refund.id,
    });
  } catch (err) {
    if (err.code && codeToStatus[err.code]) {
      return next(new AppError(err.message, codeToStatus[err.code]));
    }
    next(err);
  }
};

// ─── Stripe billing portal ────────────────────────────────────────────────
const createPortal = async (req, res, next) => {
  try {
    const origin = req.headers.origin || process.env.FRONTEND_URL || 'https://edgeai.bet';
    const { url } = await CreditService.createPortalSession({
      user: req.user, returnUrl: `${origin}/account/billing`,
    });
    res.status(HTTP_STATUS.OK).json({ success: true, url });
  } catch (err) { next(err); }
};

module.exports = {
  getBalance, getCreditPacks, createCheckout, stripeWebhook,
  getTransactions, getTransactionById, getSummary,
  requestRefund, createPortal,
};

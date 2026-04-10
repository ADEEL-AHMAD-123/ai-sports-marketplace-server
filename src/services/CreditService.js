/**
 * CreditService.js — Credit management and Stripe payment processing
 *
 * Handles:
 *  - Creating Stripe checkout sessions for credit purchases
 *  - Processing Stripe webhooks (THE reliable way to grant credits)
 *  - Querying user balance and transaction history
 *
 * IMPORTANT — STRIPE WEBHOOK FLOW:
 *  Frontend redirect is NOT reliable (user can close browser mid-payment).
 *  We ONLY grant credits when the webhook fires checkout.session.completed.
 *  This guarantees credits are added even if the user's connection drops.
 *
 * STRIPE GLOSSARY:
 *  "Checkout Session" = a hosted Stripe payment page session
 *  "Payment Intent"   = the actual payment processing object
 *  "Webhook"          = Stripe sends an HTTP POST to our server when events happen
 *  "Webhook Secret"   = used to verify the webhook actually came from Stripe
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User.model');
const Transaction = require('../models/Transaction.model');
const { CREDIT_PACKS, TRANSACTION_TYPES, CREDITS } = require('../config/constants');
const logger = require('../config/logger');

class CreditService {
  /**
   * Create a Stripe Checkout session for purchasing credits.
   * Returns a URL to redirect the user to Stripe's hosted payment page.
   *
   * @param {Object} params
   * @param {string} params.priceId  - Stripe Price ID (from CREDIT_PACKS config)
   * @param {Object} params.user     - Mongoose User document
   * @param {string} params.successUrl - URL to redirect after successful payment
   * @param {string} params.cancelUrl  - URL to redirect if user cancels
   * @returns {Promise<{ url: string, sessionId: string }>}
   */
  async createCheckoutSession({ priceId, user, successUrl, cancelUrl }) {
    // Validate that this priceId is one of our configured packs
    const pack = CREDIT_PACKS.find((p) => p.priceId === priceId);
    if (!pack) {
      throw new Error(`Invalid priceId: ${priceId}. Not found in configured credit packs.`);
    }

    logger.info('💳 [CreditService] Creating Stripe checkout session', {
      userId: user._id,
      priceId,
      credits: pack.credits,
      amount: pack.amount,
    });

    // Create or retrieve Stripe customer ID for this user
    // Storing the customer ID lets us track purchase history in Stripe dashboard
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user._id.toString() },
      });
      stripeCustomerId = customer.id;

      // Save the Stripe customer ID for future purchases
      await User.findByIdAndUpdate(user._id, { stripeCustomerId });
      logger.info('✅ [CreditService] Created Stripe customer', { userId: user._id, stripeCustomerId });
    }

    // Create the checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Pass metadata so the webhook knows which user to credit
      metadata: {
        userId: user._id.toString(),
        priceId,
        credits: pack.credits.toString(),
      },
    });

    logger.info('✅ [CreditService] Checkout session created', {
      userId: user._id,
      sessionId: session.id,
    });

    return { url: session.url, sessionId: session.id };
  }

  /**
   * Process an incoming Stripe webhook event.
   * This is the ONLY place where credits are granted for purchases.
   *
   * Called by the webhook controller after signature verification.
   *
   * @param {Object} event - Stripe event object (already verified)
   * @returns {Promise<void>}
   */
  async handleStripeWebhook(event) {
    logger.info('🔔 [CreditService] Processing Stripe webhook', { eventType: event.type, eventId: event.id });

    switch (event.type) {
      case 'checkout.session.completed':
        await this._handleCheckoutCompleted(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        // Log payment failures for monitoring — no action needed (credits not yet granted)
        logger.warn('⚠️  [CreditService] Payment failed', {
          paymentIntentId: event.data.object.id,
          failureMessage: event.data.object.last_payment_error?.message,
        });
        break;

      default:
        // We don't need to handle every Stripe event — just log and move on
        logger.debug(`[CreditService] Unhandled webhook event type: ${event.type}`);
    }
  }

  /**
   * Handle a completed checkout session — grant credits to the user.
   * IDEMPOTENT: If this session was already processed, skip it.
   *
   * @param {Object} session - Stripe checkout session object
   */
  async _handleCheckoutCompleted(session) {
    const { userId, credits, priceId } = session.metadata || {};

    logger.info('💳 [CreditService] Checkout completed', {
      sessionId: session.id,
      userId,
      credits,
    });

    // ── Idempotency check ──────────────────────────────────────────────────
    // Stripe can fire the same webhook multiple times (retry on timeout, etc.)
    // We check if this session was already processed to prevent double-crediting
    const alreadyProcessed = await Transaction.isStripeSessionProcessed(session.id);
    if (alreadyProcessed) {
      logger.warn('⚠️  [CreditService] Duplicate webhook — session already processed', {
        sessionId: session.id,
      });
      return;
    }

    // ── Validate metadata ──────────────────────────────────────────────────
    if (!userId || !credits || !priceId) {
      logger.error('❌ [CreditService] Webhook missing metadata', { sessionId: session.id, metadata: session.metadata });
      return;
    }

    const creditsToAdd = parseInt(credits, 10);
    if (isNaN(creditsToAdd) || creditsToAdd <= 0) {
      logger.error('❌ [CreditService] Invalid credits value in webhook metadata', { credits });
      return;
    }

    // ── Find user ──────────────────────────────────────────────────────────
    const user = await User.findById(userId);
    if (!user) {
      logger.error('❌ [CreditService] User not found for webhook', { userId });
      return;
    }

    // ── Grant credits ──────────────────────────────────────────────────────
    const newBalance = user.credits + creditsToAdd;

    await User.findByIdAndUpdate(userId, {
      $inc: { credits: creditsToAdd },
    });

    // ── Record transaction ─────────────────────────────────────────────────
    await Transaction.create({
      userId,
      type: TRANSACTION_TYPES.PURCHASE,
      creditDelta: creditsToAdd,
      balanceAfter: newBalance,
      description: `Purchased ${creditsToAdd} credit${creditsToAdd > 1 ? 's' : ''} via Stripe`,
      stripe: {
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
        amountPaid: session.amount_total, // In cents (e.g., 99 = $0.99)
        creditsPurchased: creditsToAdd,
      },
    });

    logger.info('✅ [CreditService] Credits granted', {
      userId,
      creditsAdded: creditsToAdd,
      newBalance,
      sessionId: session.id,
    });
  }

  /**
   * Get user's credit balance.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getBalance(userId) {
    const user = await User.findById(userId).select('credits').lean();
    return user?.credits ?? 0;
  }

  /**
   * Get user's transaction history (paginated).
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {number} params.page    - Page number (1-based)
   * @param {number} params.limit   - Items per page
   * @returns {Promise<{ transactions: Array, total: number, pages: number }>}
   */
  async getTransactionHistory({ userId, page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({ userId }),
    ]);

    return {
      transactions,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }

  /**
   * Get all available credit packs for display in the frontend.
   * Strips internal Stripe price IDs (only expose label, credits, amount).
   *
   * @returns {Array}
   */
  getCreditPacks() {
    return CREDIT_PACKS.map(({ id, credits, amount, label }) => ({
      id,
      credits,
      amount,
      label,
    }));
  }
}

module.exports = new CreditService();
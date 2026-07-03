/**
 * Transaction.model.js — Credit ledger / audit trail
 *
 * Every credit change (spend, earn, refund) is logged here.
 * This gives us:
 *  - Full audit trail for disputes
 *  - Stripe payment reconciliation
 *  - Refund tracking
 *  - Analytics on credit usage
 *
 * Think of it like a bank statement for in-app credits.
 */

const mongoose = require('mongoose');
const { TRANSACTION_TYPES, SPORTS } = require('../config/constants');

const transactionSchema = new mongoose.Schema(
  {
    // ── User reference ─────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ── Transaction details ────────────────────────────────────────────────────

    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
      index: true,
    },

    // Positive = credits added, Negative = credits spent
    // e.g., +3 for signup bonus, -1 for insight unlock, +1 for refund
    creditDelta: {
      type: Number,
      required: true,
    },

    // Credit balance AFTER this transaction (for easy balance history display)
    balanceAfter: {
      type: Number,
      required: true,
    },

    // Human-readable description of the transaction
    description: {
      type: String,
      trim: true,
    },

    // ── Payment metadata (for PURCHASE transactions) ─────────────────────────
    stripe: {
      sessionId: String,        // Stripe checkout session ID
      paymentIntentId: String,  // Stripe payment intent ID
      chargeId:      String,    // Stripe charge ID (for refunds/disputes)
      refundId:      String,    // Set when this is a REFUND transaction
      disputeId:     String,    // Set when this is a CHARGEBACK transaction
      amountPaid:    Number,    // Amount charged in USD cents
      amountRefunded: Number,   // For REFUND transactions (partial or full)
      creditsPurchased: Number,
      priceId:       String,    // The Stripe price ID that was purchased
      packId:        String,    // Our internal pack ID
    },

    // ── Insight metadata (for INSIGHT_UNLOCK / REFUND transactions) ──────────
    insight: {
      insightId: { type: mongoose.Schema.Types.ObjectId, ref: 'Insight' },
      sport: { type: String, enum: Object.values(SPORTS) },
      playerName: String,
      statType: String,
    },

    // ── Refund metadata ────────────────────────────────────────────────────────
    refundReason: {
      type: String,
      // e.g., "OpenAI API failure", "Player unavailable", "Odds changed"
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// For user transaction history page (sorted by date)
transactionSchema.index({ userId: 1, createdAt: -1 });

// For Stripe webhook deduplication on PURCHASE — prevent double-crediting.
// Not `unique` overall on sessionId because a REFUND transaction can also
// reference the same sessionId (via the original purchase's session).
transactionSchema.index(
  { 'stripe.sessionId': 1, type: 1 },
  { unique: true, sparse: true, partialFilterExpression: { type: 'purchase' } }
);

// Refund / dispute idempotency — one refund per Stripe refundId, one
// chargeback per disputeId. Prevents double credit deduction on repeat
// webhook fires.
transactionSchema.index(
  { 'stripe.refundId': 1 },
  { unique: true, sparse: true }
);
transactionSchema.index(
  { 'stripe.disputeId': 1 },
  { unique: true, sparse: true }
);

// ─── Static methods ───────────────────────────────────────────────────────────

/**
 * Check if a Stripe session has already been processed for PURCHASE.
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
transactionSchema.statics.isStripeSessionProcessed = async function (sessionId) {
  const existing = await this.findOne({
    'stripe.sessionId': sessionId,
    type: 'purchase',
  }).lean();
  return !!existing;
};

/**
 * Look up the original PURCHASE transaction for a Stripe payment intent
 * or charge. Used by the refund/dispute webhook handlers to figure out
 * which user and how many credits to reverse.
 */
transactionSchema.statics.findPurchaseByPaymentIntent = async function (paymentIntentId) {
  return this.findOne({
    'stripe.paymentIntentId': paymentIntentId,
    type: 'purchase',
  });
};
transactionSchema.statics.findPurchaseByCharge = async function (chargeId) {
  return this.findOne({ 'stripe.chargeId': chargeId, type: 'purchase' });
};

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
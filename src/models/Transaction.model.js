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
      sessionId: String,      // Stripe checkout session ID
      paymentIntentId: String, // Stripe payment intent ID
      amountPaid: Number,      // Amount charged in USD cents (e.g., 99 = $0.99)
      creditsPurchased: Number,
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

// For Stripe webhook deduplication (prevent double-crediting)
transactionSchema.index(
  { 'stripe.sessionId': 1 },
  { unique: true, sparse: true } // sparse: only index docs where field exists
);

// ─── Static methods ───────────────────────────────────────────────────────────

/**
 * Check if a Stripe session has already been processed.
 * Used by the webhook handler to prevent duplicate credit grants.
 *
 * @param {string} sessionId - Stripe checkout session ID
 * @returns {Promise<boolean>}
 */
transactionSchema.statics.isStripeSessionProcessed = async function (sessionId) {
  const existing = await this.findOne({ 'stripe.sessionId': sessionId }).lean();
  return !!existing;
};

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
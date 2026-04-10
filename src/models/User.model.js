/**
 * User.model.js — User account schema
 *
 * Stores: authentication info, credit balance, role.
 * Credit history is tracked in a separate Transaction model for full audit trail.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_ROLES, CREDITS } = require('../config/constants');

const userSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [60, 'Name cannot exceed 60 characters'],
    },

    // ── Authentication ────────────────────────────────────────────────────────
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // Never include password in query results by default
    },

    // ── Role ──────────────────────────────────────────────────────────────────
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.USER,
    },

    // ── Credits (in-app currency) ─────────────────────────────────────────────
    credits: {
      type: Number,
      default: CREDITS.FREE_ON_SIGNUP,
      min: [0, 'Credits cannot be negative'],
    },

    // ── Unlocked insights ─────────────────────────────────────────────────────
    // Array of insight IDs this user has already unlocked.
    // Used to prevent double-charging (if insight is in this array → free access).
    unlockedInsights: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Insight',
      },
    ],

    // ── Account state ─────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },
    // Tracks email verification (useful for future email verification feature)
    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    // ── Password reset ────────────────────────────────────────────────────────
    passwordResetToken: String,
    passwordResetExpires: Date,

    // ── Stripe customer ID ────────────────────────────────────────────────────
    // Stored so we can look up the user in Stripe for refunds / history
    stripeCustomerId: {
      type: String,
      index: true,
    },

    // ── Timestamps ────────────────────────────────────────────────────────────
    lastLoginAt: Date,
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Compound index for admin queries filtering by role + active status
userSchema.index({ role: 1, isActive: 1 });

// ─── Pre-save hook: Hash password before storing ──────────────────────────────
userSchema.pre('save', async function (next) {
  // Only hash if password field was modified (e.g. not on profile update)
  if (!this.isModified('password')) return next();

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
  this.password = await bcrypt.hash(this.password, rounds);
  next();
});

// ─── Instance methods ─────────────────────────────────────────────────────────

/**
 * Compare a plain-text password against the stored hash.
 * Used during login.
 *
 * @param {string} candidatePassword - Plain text from login form
 * @returns {Promise<boolean>}
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Check if the user has already unlocked a specific insight.
 * Returns true = already unlocked → DO NOT deduct credits.
 *
 * @param {ObjectId|string} insightId
 * @returns {boolean}
 */
userSchema.methods.hasUnlockedInsight = function (insightId) {
  return this.unlockedInsights.some(
    (id) => id.toString() === insightId.toString()
  );
};

/**
 * Check if the user has enough credits to unlock an insight.
 *
 * @param {number} [cost=CREDITS.COST_PER_INSIGHT]
 * @returns {boolean}
 */
userSchema.methods.hasEnoughCredits = function (cost = CREDITS.COST_PER_INSIGHT) {
  return this.credits >= cost;
};

// ─── Virtual: public profile ──────────────────────────────────────────────────
// Use this when returning user data to the frontend.
// Strips sensitive fields automatically.
userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    credits: this.credits,
    isEmailVerified: this.isEmailVerified,
    createdAt: this.createdAt,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = User;
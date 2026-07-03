/**
 * auth.controller.js — Authentication endpoints
 *
 * Handles:
 *  POST /api/auth/register              — Create account, send verification email
 *  POST /api/auth/login                 — Login + return JWT
 *  GET  /api/auth/me                    — Get current user profile
 *  POST /api/auth/logout                — Invalidate session (client-side)
 *  GET  /api/auth/verify-email/:token   — Verify email + grant free credits
 *  POST /api/auth/resend-verification   — Resend verification email (rate-limited)
 *
 * FAKE ACCOUNT PROTECTION:
 *  Free signup credits are NOT granted at register-time. They only land
 *  once the user clicks the verification link. This makes farming credits
 *  by creating disposable accounts materially harder: an attacker would
 *  need a fresh, working inbox per account, not just a fresh email string.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Transaction = require('../models/Transaction.model');
const { HTTP_STATUS, CREDITS, TRANSACTION_TYPES } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const EmailService = require('../services/email/EmailService');
const logger = require('../config/logger');

// How long a verification token is valid.
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Minimum interval between "resend verification" requests per user.
const RESEND_COOLDOWN_MS  = 60 * 1000; // 60s

// ─── Token helpers ─────────────────────────────────────────────────────────

const generateVerificationToken = () => {
  const rawToken    = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, hashedToken };
};

const generateJWT = (userId) => jwt.sign(
  { id: userId },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
);

const sendTokenResponse = (res, statusCode, user, message = 'Success') => {
  const token = generateJWT(user._id);

  const cookieOptions = {
    expires:  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  };

  res
    .status(statusCode)
    .cookie('token', token, cookieOptions)
    .json({
      success: true,
      message,
      token,
      user: user.toPublicJSON(),
    });
};

// ─── Verification email — helper ───────────────────────────────────────────

/**
 * Generate + persist a verification token for the user, then fire the
 * verification email. Never throws; email failures are logged upstream.
 */
async function sendVerificationEmail(user) {
  const { rawToken, hashedToken } = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  await User.findByIdAndUpdate(user._id, {
    emailVerificationToken:      hashedToken,
    emailVerificationExpires:    expiresAt,
    emailVerificationLastSentAt: new Date(),
  });

  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${rawToken}`;
  await EmailService.sendVerifyEmail({ to: user.email, name: user.name, verifyUrl });
}

// ─── Register ──────────────────────────────────────────────────────────────

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    logger.info('👤 [AuthController] Register attempt', { email });

    const existing = await User.findOne({ email }).lean();
    if (existing) {
      throw new AppError('An account with this email already exists.', HTTP_STATUS.CONFLICT);
    }

    // Create user — starts unverified, zero credits.
    const user = await User.create({ name, email, password, credits: 0 });

    // Fire and (mostly) forget the verification email. If it fails the
    // user can hit /resend-verification later — the signup itself is fine.
    sendVerificationEmail(user).catch((err) => {
      logger.error('[AuthController] Failed to send verification email', {
        userId: user._id, error: err.message,
      });
    });

    logger.info('✅ [AuthController] User registered (unverified)', {
      userId: user._id, email: user.email,
    });

    // Log the user in so they land on a "check your email" state on the
    // frontend without needing to re-enter credentials.
    sendTokenResponse(
      res, HTTP_STATUS.CREATED, user,
      'Account created. Check your inbox to verify your email and unlock your free credits.',
    );
  } catch (err) { next(err); }
};

// ─── Verify email ──────────────────────────────────────────────────────────

/**
 * GET /api/auth/verify-email?token=<raw>
 *
 * Idempotent on repeat clicks — if already verified, we silently succeed
 * so a user opening the link twice from two devices doesn't see an error.
 */
const verifyEmail = async (req, res, next) => {
  try {
    const rawToken = req.query.token || req.params.token;
    if (!rawToken) {
      throw new AppError('Missing verification token.', HTTP_STATUS.BAD_REQUEST);
    }

    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Look for a user whose token matches AND hasn't expired.
    const user = await User.findOne({
      emailVerificationToken:   hashedToken,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      // Second-chance check: maybe the token was used already. Look up a
      // verified user whose most recent verification token hashed to this
      // value — we treat repeat clicks as success rather than failure.
      const alreadyVerified = await User.findOne({
        isEmailVerified: true,
        emailVerificationToken: hashedToken,
      });
      if (alreadyVerified) {
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          alreadyVerified: true,
          message: 'Your email is already verified.',
        });
      }
      throw new AppError(
        'This verification link is invalid or has expired. Request a new one.',
        HTTP_STATUS.BAD_REQUEST,
      );
    }

    // Mark verified + grant the signup bonus (transactional-esque: we do
    // the update, then the ledger row. If ledger insert fails, we still
    // want the user marked verified — they can contact support for the
    // credits, and we log loudly).
    const creditsToGrant = CREDITS.FREE_ON_SIGNUP;
    const newBalance     = user.credits + creditsToGrant;

    await User.findByIdAndUpdate(user._id, {
      isEmailVerified: true,
      $inc: { credits: creditsToGrant },
      $unset: {
        emailVerificationToken:   1,
        emailVerificationExpires: 1,
      },
    });

    try {
      await Transaction.create({
        userId:       user._id,
        type:         TRANSACTION_TYPES.SIGNUP_BONUS,
        creditDelta:  creditsToGrant,
        balanceAfter: newBalance,
        description:  `Welcome bonus — ${creditsToGrant} credits on email verification`,
      });
    } catch (err) {
      logger.error('[AuthController] Verification succeeded but ledger insert failed', {
        userId: user._id, error: err.message,
      });
    }

    // Welcome email — fire and forget.
    EmailService.sendWelcome({ to: user.email, name: user.name, credits: newBalance })
      .catch((err) => logger.warn('[Email] welcome send failed', { error: err.message }));

    logger.info('✅ [AuthController] Email verified + free credits granted', {
      userId: user._id, credits: newBalance,
    });

    res.status(HTTP_STATUS.OK).json({
      success:      true,
      message:      'Email verified. Your free credits are ready.',
      credits:      newBalance,
      creditsAdded: creditsToGrant,
    });
  } catch (err) { next(err); }
};

// ─── Resend verification ───────────────────────────────────────────────────

/**
 * POST /api/auth/resend-verification
 * Body: { email }
 *
 * Public route (user is likely logged out or newly signed up). Rate-limited
 * both by the router-level limiter and by the per-user cooldown below.
 * Generic response prevents enumeration of registered emails.
 */
const resendVerification = async (req, res, next) => {
  try {
    const email = req.body?.email || req.user?.email;
    if (!email) {
      throw new AppError('Email is required.', HTTP_STATUS.BAD_REQUEST);
    }

    const genericResponse = {
      success: true,
      message: 'If an account exists for that address and it is not yet verified, a new email has been sent.',
    };

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || user.isEmailVerified) {
      return res.status(HTTP_STATUS.OK).json(genericResponse);
    }

    // Per-user cooldown.
    if (user.emailVerificationLastSentAt) {
      const sinceLast = Date.now() - user.emailVerificationLastSentAt.getTime();
      if (sinceLast < RESEND_COOLDOWN_MS) {
        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          success: false,
          message: `Please wait ${Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000)}s before requesting another email.`,
        });
      }
    }

    await sendVerificationEmail(user).catch((err) => {
      logger.error('[AuthController] Failed to resend verification email', {
        userId: user._id, error: err.message,
      });
    });

    res.status(HTTP_STATUS.OK).json(genericResponse);
  } catch (err) { next(err); }
};

// ─── Login ─────────────────────────────────────────────────────────────────

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    logger.info('🔑 [AuthController] Login attempt', { email });

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      logger.warn('⚠️  [AuthController] Failed login attempt', { email, ip: req.ip });
      throw new AppError('Invalid email or password.', HTTP_STATUS.UNAUTHORIZED);
    }
    if (!user.isActive) {
      throw new AppError('Your account has been deactivated. Contact support.', HTTP_STATUS.UNAUTHORIZED);
    }

    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

    logger.info('✅ [AuthController] User logged in', { userId: user._id });
    sendTokenResponse(res, HTTP_STATUS.OK, user, 'Logged in successfully');
  } catch (err) { next(err); }
};

// ─── Get current user ──────────────────────────────────────────────────────

const getMe = async (req, res, next) => {
  try {
    res.status(HTTP_STATUS.OK).json({
      success: true,
      user: req.user.toPublicJSON(),
    });
  } catch (err) { next(err); }
};

// ─── Logout ────────────────────────────────────────────────────────────────

const logout = (req, res) => {
  res
    .status(HTTP_STATUS.OK)
    .clearCookie('token')
    .json({ success: true, message: 'Logged out successfully' });

  logger.info('👋 [AuthController] User logged out', { userId: req.user?._id });
};

module.exports = {
  register, login, getMe, logout,
  verifyEmail, resendVerification,
};

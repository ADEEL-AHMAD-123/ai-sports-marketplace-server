/**
 * auth.controller.js — Authentication endpoints
 *
 * Handles:
 *  POST /api/auth/register  — Create account + grant free credits
 *  POST /api/auth/login     — Login + return JWT
 *  GET  /api/auth/me        — Get current user profile
 *  POST /api/auth/logout    — Invalidate session (client-side)
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Transaction = require('../models/Transaction.model');
const { HTTP_STATUS, CREDITS, TRANSACTION_TYPES } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

/**
 * Generate a signed JWT for a user.
 * @param {string} userId
 * @returns {string} Signed JWT
 */
const generateToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

/**
 * Send token response — attaches JWT to both JSON body and cookie.
 * Cookie is httpOnly (JS can't read it) — protects against XSS.
 */
const sendTokenResponse = (res, statusCode, user, message = 'Success') => {
  const token = generateToken(user._id);

  // Cookie options
  const cookieOptions = {
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    httpOnly: true,  // Cannot be accessed by JavaScript
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
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

// ─── Register ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Creates a new user account and grants free credits.
 */
const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    logger.info('👤 [AuthController] Register attempt', { email });

    // Check if email is already taken
    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      throw new AppError('An account with this email already exists.', HTTP_STATUS.CONFLICT);
    }

    // Create user (password hashing handled by pre-save hook in User model)
    const user = await User.create({ name, email, password });

    // Log the signup bonus transaction
    await Transaction.create({
      userId: user._id,
      type: TRANSACTION_TYPES.SIGNUP_BONUS,
      creditDelta: CREDITS.FREE_ON_SIGNUP,
      balanceAfter: CREDITS.FREE_ON_SIGNUP,
      description: `Welcome! ${CREDITS.FREE_ON_SIGNUP} free credits on signup`,
    });

    logger.info('✅ [AuthController] User registered', {
      userId: user._id,
      email: user.email,
      freeCredits: CREDITS.FREE_ON_SIGNUP,
    });

    sendTokenResponse(res, HTTP_STATUS.CREATED, user, 'Account created successfully!');
  } catch (err) {
    next(err);
  }
};

// ─── Login ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    logger.info('🔑 [AuthController] Login attempt', { email });

    // Find user — include password for comparison (it's excluded by default)
    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      // Generic message — don't reveal whether email or password is wrong (security)
      logger.warn('⚠️  [AuthController] Failed login attempt', { email, ip: req.ip });
      throw new AppError('Invalid email or password.', HTTP_STATUS.UNAUTHORIZED);
    }

    if (!user.isActive) {
      throw new AppError('Your account has been deactivated. Contact support.', HTTP_STATUS.UNAUTHORIZED);
    }

    // Update last login timestamp
    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

    logger.info('✅ [AuthController] User logged in', { userId: user._id });

    sendTokenResponse(res, HTTP_STATUS.OK, user, 'Logged in successfully');
  } catch (err) {
    next(err);
  }
};

// ─── Get current user ──────────────────────────────────────────────────────────

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile.
 * Protected route — requires valid JWT.
 */
const getMe = async (req, res, next) => {
  try {
    // req.user is already attached by protect middleware
    res.status(HTTP_STATUS.OK).json({
      success: true,
      user: req.user.toPublicJSON(),
    });
  } catch (err) {
    next(err);
  }
};

// ─── Logout ────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/logout
 * Clears the auth cookie.
 * JWTs are stateless — we clear the cookie and the client discards the token.
 */
const logout = (req, res) => {
  res
    .status(HTTP_STATUS.OK)
    .clearCookie('token')
    .json({ success: true, message: 'Logged out successfully' });

  logger.info('👋 [AuthController] User logged out', { userId: req.user?._id });
};

module.exports = { register, login, getMe, logout };
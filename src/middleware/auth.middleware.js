/**
 * auth.middleware.js — JWT authentication and authorization middleware
 *
 * Two exported middlewares:
 *  1. protect    — verifies JWT, attaches user to req.user (required for private routes)
 *  2. restrictTo — role-based access control (e.g., admin-only routes)
 *
 * Usage in routes:
 *   router.get('/wallet', protect, walletController.getBalance);
 *   router.get('/admin/stats', protect, restrictTo('admin'), adminController.getStats);
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const { HTTP_STATUS, USER_ROLES } = require('../config/constants');
const logger = require('../config/logger');

/**
 * Protect middleware — validates JWT and attaches user to request.
 * Rejects requests with no token, invalid tokens, or deleted user accounts.
 */
const protect = async (req, res, next) => {
  try {
    // ── Extract token ──────────────────────────────────────────────────────
    // Accept token from Authorization header (Bearer token) OR cookie
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Authentication required. Please log in.',
      });
    }

    // ── Verify token ───────────────────────────────────────────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      // Log invalid tokens (could indicate an attack or expired session)
      logger.warn('⚠️  [Auth] Invalid or expired JWT', {
        ip: req.ip,
        error: jwtError.message,
      });

      const message = jwtError.name === 'TokenExpiredError'
        ? 'Session expired. Please log in again.'
        : 'Invalid token. Please log in.';

      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ success: false, message });
    }

    // ── Find user ──────────────────────────────────────────────────────────
    // Re-query DB to ensure account still exists and is active
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Account not found. Please log in again.',
      });
    }

    if (!user.isActive) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Your account has been deactivated. Contact support.',
      });
    }

    // ── Attach user to request ─────────────────────────────────────────────
    req.user = user;
    next();
  } catch (err) {
    logger.error('❌ [Auth] protect middleware error', { error: err.message });
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      message: 'Authentication failed. Please try again.',
    });
  }
};

/**
 * Role-based access control middleware.
 * Must be used AFTER protect middleware.
 *
 * @param {...string} roles - Allowed roles (e.g., 'admin', 'user')
 *
 * Usage: restrictTo('admin') or restrictTo('admin', 'moderator')
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!roles.includes(req.user.role)) {
      logger.warn('⚠️  [Auth] Unauthorized role access attempt', {
        userId: req.user._id,
        userRole: req.user.role,
        requiredRoles: roles,
        path: req.path,
      });

      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        message: 'You do not have permission to perform this action.',
      });
    }

    next();
  };
};

/**
 * Optional auth middleware — attaches user if token is present, but
 * doesn't block the request if no token is provided.
 *
 * Used for routes that show extra content to logged-in users
 * (e.g., blurred insights for guests, full insights for authenticated users).
 */
const optionalAuth = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password');
      if (user && user.isActive) {
        req.user = user;
      }
    }

    next();
  } catch {
    // Token was invalid — just proceed as unauthenticated (don't block)
    next();
  }
};

module.exports = { protect, restrictTo, optionalAuth };
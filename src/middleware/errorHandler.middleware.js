/**
 * errorHandler.middleware.js — Global error handling middleware
 *
 * Catches all errors thrown or passed via next(err) in the app.
 * Sends structured JSON error responses and logs everything.
 *
 * Handles:
 *  - Mongoose validation errors (400)
 *  - Mongoose duplicate key errors (409)
 *  - Mongoose cast errors (bad ObjectId) (400)
 *  - JWT errors (401)
 *  - Custom AppError (any status)
 *  - Unhandled errors (500)
 *
 * Usage:
 *  app.use(errorHandler); — must be the LAST middleware registered
 */

const logger = require('../config/logger');
const { HTTP_STATUS } = require('../config/constants');

/**
 * Custom error class for operational errors.
 * Use this to throw expected errors (e.g., "User not found", "Insufficient credits").
 *
 * Usage:
 *   throw new AppError('Insufficient credits', 402);
 */
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // Distinguishes from unexpected programming errors
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global error handling middleware.
 * Express identifies this as an error handler because it has 4 parameters (err, req, res, next).
 */
const errorHandler = (err, req, res, next) => {
  // Clone to avoid mutating the original error
  let error = { ...err };
  error.message = err.message;
  error.stack = err.stack;

  // ── Log the error ──────────────────────────────────────────────────────────
  if (err.statusCode >= 500 || !err.isOperational) {
    // Server errors get full stack trace in logs
    logger.error('❌ [ErrorHandler] Unhandled error', {
      message: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
      ip: req.ip,
      userId: req.user?._id,
    });
  } else {
    // Client errors (4xx) get less verbose logs
    logger.warn('⚠️  [ErrorHandler] Client error', {
      message: err.message,
      statusCode: err.statusCode,
      url: req.originalUrl,
      method: req.method,
      userId: req.user?._id,
    });
  }

  // ── Handle specific Mongoose errors ───────────────────────────────────────

  // Mongoose validation error (e.g., required field missing)
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: 'Validation failed',
      errors: messages,
    });
  }

  // Mongoose duplicate key error (e.g., duplicate email on signup)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(HTTP_STATUS.CONFLICT).json({
      success: false,
      message: `A record with that ${field} already exists.`,
    });
  }

  // Mongoose invalid ObjectId (e.g., malformed ID in URL param)
  if (err.name === 'CastError') {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: `Invalid ID format: ${err.value}`,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: 'Invalid authentication token.',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      message: 'Session expired. Please log in again.',
    });
  }

  // ── Operational errors (thrown via AppError) ──────────────────────────────
  if (err.isOperational) {
    return res.status(err.statusCode || HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: err.message,
    });
  }

  // ── Unhandled/unexpected errors ────────────────────────────────────────────
  // Don't leak internal error details to the client in production
  const isDev = process.env.NODE_ENV === 'development';

  return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
    success: false,
    message: isDev ? err.message : 'Something went wrong. Please try again.',
    ...(isDev && { stack: err.stack }), // Show stack trace only in development
  });
};

/**
 * 404 handler — for routes that don't exist.
 * Register BEFORE the errorHandler.
 */
const notFoundHandler = (req, res, next) => {
  logger.warn(`⚠️  [404] Route not found: ${req.method} ${req.originalUrl}`, { ip: req.ip });
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, HTTP_STATUS.NOT_FOUND));
};

module.exports = { errorHandler, notFoundHandler, AppError };
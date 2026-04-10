/**
 * validate.middleware.js — Request validation middleware
 *
 * Uses express-validator to validate and sanitize incoming request data.
 * Each exported function is a validation chain for a specific route.
 *
 * Pattern:
 *  1. Define validation rules as an array of checks
 *  2. Use handleValidationErrors to auto-reject invalid requests
 *  3. Attach to route: router.post('/register', validateRegister, authController.register)
 */

const { body, param, query, validationResult } = require('express-validator');
const { HTTP_STATUS, SPORTS, MARKET_TYPES } = require('../config/constants');

/**
 * Central validation error handler.
 * Returns 400 with all validation errors if any checks failed.
 * Must be the LAST item in a validation chain array.
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((e) => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }

  next();
};

// ─── Auth validations ──────────────────────────────────────────────────────────

const validateRegister = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 60 }).withMessage('Name must be 2–60 characters'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Please provide a valid email')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

  handleValidationErrors,
];

const validateLogin = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Please provide a valid email')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('Password is required'),

  handleValidationErrors,
];

// ─── Insight validations ────────────────────────────────────────────────────────

const validateInsightRequest = [
  body('sport')
    .notEmpty().withMessage('Sport is required')
    .isIn(Object.values(SPORTS)).withMessage(`Sport must be one of: ${Object.values(SPORTS).join(', ')}`),

  body('eventId')
    .notEmpty().withMessage('Event ID is required')
    .isString().withMessage('Event ID must be a string'),

  body('playerName')
    .trim()
    .notEmpty().withMessage('Player name is required')
    .isLength({ max: 100 }).withMessage('Player name too long'),

  body('statType')
    .trim()
    .notEmpty().withMessage('Stat type is required')
    .toLowerCase(),

  body('bettingLine')
    .notEmpty().withMessage('Betting line is required')
    .isFloat({ min: 0 }).withMessage('Betting line must be a positive number'),

  body('marketType')
    .notEmpty().withMessage('Market type is required')
    .isIn(Object.values(MARKET_TYPES)).withMessage(`Market type must be one of: ${Object.values(MARKET_TYPES).join(', ')}`),

  handleValidationErrors,
];

// ─── Odds/Games validations ─────────────────────────────────────────────────────

const validateSportParam = [
  param('sport')
    .isIn(Object.values(SPORTS)).withMessage(`Sport must be one of: ${Object.values(SPORTS).join(', ')}`),
  handleValidationErrors,
];

const validateEventIdParam = [
  param('eventId')
    .notEmpty().withMessage('Event ID is required')
    .isString(),
  handleValidationErrors,
];

// ─── Pagination validation ──────────────────────────────────────────────────────

const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100')
    .toInt(),

  handleValidationErrors,
];

// ─── Credit pack validation ─────────────────────────────────────────────────────

const validateCreditPurchase = [
  body('packId')
    .notEmpty().withMessage('Pack ID is required')
    .isString().withMessage('Pack ID must be a string'),

  handleValidationErrors,
];

module.exports = {
  handleValidationErrors,
  validateRegister,
  validateLogin,
  validateInsightRequest,
  validateSportParam,
  validateEventIdParam,
  validatePagination,
  validateCreditPurchase,
};
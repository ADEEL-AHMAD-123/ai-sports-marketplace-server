/**
 * auth.routes.js — Authentication routes
 */
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const authController = require('../controllers/auth.controller');
const { forgotPassword, resetPassword } = require('../services/passwordReset.service');
const { protect } = require('../middleware/auth.middleware');
const { validateRegister, validateLogin } = require('../middleware/validate.middleware');

// Rate limit for the resend-verification endpoint. Backed up by the
// per-user 60-second cooldown in the controller — this is IP-level
// defence against bots hammering the endpoint.
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,                   // 5 resends per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification requests. Please try again later.' },
});

// ── Public routes ──────────────────────────────────────────────────────────────
router.post('/register',        validateRegister, authController.register);
router.post('/login',           validateLogin,    authController.login);
router.post('/logout',                            authController.logout);
router.post('/forgot-password',                   forgotPassword);
router.post('/reset-password',                    resetPassword);

// Email verification — the token can come as ?token=... or /:token/,
// so both are supported. Everyone forgets one or the other.
router.get ('/verify-email',        authController.verifyEmail);
router.get ('/verify-email/:token', authController.verifyEmail);
router.post('/resend-verification', resendLimiter, authController.resendVerification);

// ── Protected routes ───────────────────────────────────────────────────────────
router.get('/me', protect, authController.getMe);

module.exports = router;

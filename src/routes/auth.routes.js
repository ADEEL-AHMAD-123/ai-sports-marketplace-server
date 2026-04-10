/**
 * auth.routes.js — Authentication routes
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { forgotPassword, resetPassword } = require('../services/passwordReset.service');
const { protect } = require('../middleware/auth.middleware');
const { validateRegister, validateLogin } = require('../middleware/validate.middleware');

// ── Public routes ──────────────────────────────────────────────────────────────
router.post('/register',        validateRegister, authController.register);
router.post('/login',           validateLogin,    authController.login);
router.post('/logout',                            authController.logout);
router.post('/forgot-password',                   forgotPassword);
router.post('/reset-password',                    resetPassword);

// ── Protected routes ───────────────────────────────────────────────────────────
router.get('/me', protect, authController.getMe);

module.exports = router;
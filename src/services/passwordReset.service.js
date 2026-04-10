/**
 * passwordReset.service.js — Password reset flow
 *
 * Flow:
 *  1. User submits email → forgotPassword()
 *     - Generate a secure random token
 *     - Hash and store it in DB with 1-hour expiry
 *     - In production: email the raw token to the user
 *     - In development: return the token directly in the response (for testing)
 *
 *  2. User submits new password + token → resetPassword()
 *     - Hash the incoming token and compare with stored hash
 *     - If valid and not expired → update password + clear token
 *
 * Note: We hash the token before storing (same principle as passwords).
 * If someone gets DB access, they can't use the tokens directly.
 *
 * Email sending is intentionally a stub here — plug in your preferred
 * email provider (SendGrid, Resend, Nodemailer) in the sendResetEmail() function.
 */

const crypto = require('crypto');
const User = require('../models/User.model');
const { HTTP_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

/**
 * Generate a secure random reset token.
 * Returns both the raw token (to send to user) and hashed token (to store in DB).
 *
 * @returns {{ rawToken: string, hashedToken: string }}
 */
const generateResetToken = () => {
  // 32 random bytes → 64 character hex string
  const rawToken = crypto.randomBytes(32).toString('hex');
  // Hash before storing — prevents DB breach from giving usable tokens
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, hashedToken };
};

/**
 * POST /api/auth/forgot-password
 * Initiates the password reset flow.
 *
 * Body: { email }
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new AppError('Email is required', HTTP_STATUS.BAD_REQUEST);
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // SECURITY: Always return the same response whether email exists or not.
    // This prevents "email enumeration" attacks where an attacker can discover
    // which emails are registered by checking the response.
    const genericResponse = {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    };

    if (!user) {
      logger.warn('[PasswordReset] Forgot password for unknown email', { email });
      return res.status(HTTP_STATUS.OK).json(genericResponse);
    }

    // Generate and store reset token
    const { rawToken, hashedToken } = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    await User.findByIdAndUpdate(user._id, {
      passwordResetToken: hashedToken,
      passwordResetExpires: expiresAt,
    });

    logger.info('[PasswordReset] Reset token generated', { userId: user._id });

    // ── Send email ──────────────────────────────────────────────────────────
    // TODO: Replace this stub with your email provider
    // The reset URL would be: https://yourapp.com/reset-password?token=rawToken
    await sendResetEmail({ email: user.email, name: user.name, rawToken });

    // In development: also return the token so you can test without email setup
    const responseData = { ...genericResponse };
    if (process.env.NODE_ENV === 'development') {
      responseData._devToken = rawToken; // Remove this before going to production!
      logger.debug('[PasswordReset] DEV MODE — raw token returned in response', { rawToken });
    }

    res.status(HTTP_STATUS.OK).json(responseData);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/reset-password
 * Completes the password reset.
 *
 * Body: { token, newPassword }
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      throw new AppError('Token and new password are required', HTTP_STATUS.BAD_REQUEST);
    }

    if (newPassword.length < 8) {
      throw new AppError('Password must be at least 8 characters', HTTP_STATUS.BAD_REQUEST);
    }

    // Hash the incoming token to compare with the stored hash
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with this token that hasn't expired yet
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() }, // Token must not be expired
    });

    if (!user) {
      throw new AppError(
        'Password reset token is invalid or has expired. Please request a new one.',
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Update password (pre-save hook in User model handles hashing)
    user.password = newPassword;
    user.passwordResetToken = undefined; // Clear the token
    user.passwordResetExpires = undefined;
    await user.save();

    logger.info('[PasswordReset] Password reset successful', { userId: user._id });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Password reset successful. You can now log in with your new password.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Email sending stub.
 * Replace the body of this function with your email provider's SDK.
 *
 * Popular options:
 *  - Resend:    https://resend.com (simplest, modern)
 *  - SendGrid:  https://sendgrid.com
 *  - Nodemailer: for SMTP (Gmail, etc.)
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.name
 * @param {string} params.rawToken
 */
const sendResetEmail = async ({ email, name, rawToken }) => {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;

  // ── STUB — replace with real email sending ──────────────────────────────
  logger.info('[PasswordReset] EMAIL STUB — would send reset email', {
    to: email,
    resetUrl,
    // In production, never log the raw token
  });

  // Example with Resend (install: npm install resend):
  // const { Resend } = require('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: 'noreply@yourapp.com',
  //   to: email,
  //   subject: 'Reset your password',
  //   html: `<p>Hi ${name},</p>
  //          <p>Click the link below to reset your password. It expires in 1 hour.</p>
  //          <a href="${resetUrl}">Reset Password</a>`,
  // });
};

module.exports = { forgotPassword, resetPassword };
/**
 * EmailService.js — Single entry point for outbound email
 *
 * Uses Mailtrap's Node SDK for both:
 *   - Production sending (transactional Sending API)
 *   - Local / staging inbox testing (sandbox mode)
 *
 * DESIGN NOTES:
 *
 *  1. Silent-failure-safe. Signup and purchase flows must never crash
 *     because email failed. Every send() catches, logs, and returns a
 *     result object rather than throwing. Callers can inspect success
 *     but should never block on it.
 *
 *  2. Dev-mode short-circuit. If MAILTRAP_API_TOKEN isn't set (local
 *     dev without email creds), we log the email contents and pretend
 *     it sent. Prevents dev friction when working on flow logic.
 *
 *  3. Sandbox vs live. MAILTRAP_MODE = 'sandbox' | 'send' | 'both'. In
 *     sandbox mode, emails land in a test inbox and never reach real
 *     recipients — perfect for staging environments so we don't spam
 *     real users during QA. Production should be 'send'.
 *
 *  4. From address is centralised. Never let callers pass a from
 *     override — that's how spoofing bugs happen.
 */

const { MailtrapClient } = require('mailtrap');
const templates = require('./templates');
const logger = require('../../config/logger');

const {
  MAILTRAP_API_TOKEN,
  MAILTRAP_ACCOUNT_ID,
  MAILTRAP_TEST_INBOX_ID,
  MAILTRAP_MODE = 'send',
  MAIL_FROM_EMAIL = 'hello@edgeai.bet',
  MAIL_FROM_NAME  = 'EdgeAI',
  MAIL_ADMIN_EMAIL,
  NODE_ENV,
} = process.env;

const isDev = NODE_ENV !== 'production';
const hasToken = Boolean(MAILTRAP_API_TOKEN);

// Lazy client — built once on first send.
let _client = null;
let _clientMode = null; // 'sandbox' | 'send'

const _getClient = (mode) => {
  if (_client && _clientMode === mode) return _client;
  if (mode === 'sandbox') {
    _client = new MailtrapClient({
      token: MAILTRAP_API_TOKEN,
      sandbox: true,
      testInboxId: Number(MAILTRAP_TEST_INBOX_ID),
    });
  } else {
    _client = new MailtrapClient({ token: MAILTRAP_API_TOKEN });
  }
  _clientMode = mode;
  return _client;
};

// Common "from" envelope. Centralised so no template can accidentally
// spoof a different sender.
const FROM = { email: MAIL_FROM_EMAIL, name: MAIL_FROM_NAME };

/**
 * Send an email. Never throws — always resolves with a result object.
 *
 * @returns {Promise<{ success: boolean, mode: string, messageIds?: any, error?: string }>}
 */
async function send({ to, subject, html, text, category }) {
  if (!to || !subject || (!html && !text)) {
    logger.warn('[Email] send() called with missing fields', { to: !!to, subject: !!subject });
    return { success: false, mode: 'invalid', error: 'missing_fields' };
  }

  // Dev-mode fallback — log the contents so devs can copy the URL out
  // without needing Mailtrap creds.
  if (!hasToken) {
    logger.info('📧 [Email] STUB (no MAILTRAP_API_TOKEN set) — would send', {
      to, subject, category, textPreview: (text || '').slice(0, 200),
    });
    return { success: true, mode: 'stub' };
  }

  const modes = MAILTRAP_MODE === 'both'
    ? ['sandbox', 'send']
    : [MAILTRAP_MODE || 'send'];

  const results = [];
  for (const mode of modes) {
    try {
      const client = _getClient(mode);
      const res = await client.send({
        from: FROM,
        to:   [{ email: to }],
        subject,
        html,
        text,
        category, // Mailtrap tag — categorises in dashboard analytics
      });
      results.push({ mode, ok: true, messageIds: res?.message_ids });
      logger.info('📧 [Email] Sent', { mode, to, subject, category });
    } catch (err) {
      results.push({ mode, ok: false, error: err.message });
      logger.error('❌ [Email] Send failed', {
        mode, to, subject, category, error: err.message,
      });
    }
  }

  const anyOk = results.some((r) => r.ok);
  return {
    success: anyOk,
    mode:    _clientMode || MAILTRAP_MODE,
    results,
  };
}

// ─── Public API — one function per template ────────────────────────────

const sendVerifyEmail = ({ to, name, verifyUrl }) =>
  send({ to, category: 'verify-email', ...templates.verifyEmail({ name, verifyUrl }) });

const sendWelcome = ({ to, name, credits }) =>
  send({ to, category: 'welcome', ...templates.welcome({ name, credits }) });

const sendPasswordReset = ({ to, name, resetUrl }) =>
  send({ to, category: 'password-reset', ...templates.passwordReset({ name, resetUrl }) });

const sendPurchaseReceipt = ({ to, name, packLabel, credits, amountUSD, newBalance, sessionId }) =>
  send({
    to, category: 'receipt',
    ...templates.purchaseReceipt({ name, packLabel, credits, amountUSD, newBalance, sessionId }),
  });

const sendRefundConfirmation = ({ to, name, amountUSD, creditsReversed, refundId }) =>
  send({
    to, category: 'refund',
    ...templates.refundConfirmation({ name, amountUSD, creditsReversed, refundId }),
  });

/**
 * Admin notification for chargebacks. No-op if MAIL_ADMIN_EMAIL not set.
 */
const sendChargebackAlert = ({ userEmail, disputeId, amountUSD, reason }) => {
  if (!MAIL_ADMIN_EMAIL) {
    logger.warn('[Email] MAIL_ADMIN_EMAIL not set — chargeback alert skipped');
    return Promise.resolve({ success: false, mode: 'skipped' });
  }
  return send({
    to: MAIL_ADMIN_EMAIL,
    category: 'chargeback-alert',
    ...templates.chargebackAlert({ userEmail, disputeId, amountUSD, reason }),
  });
};

module.exports = {
  send,                    // Low-level, in case a caller needs custom content
  sendVerifyEmail,
  sendWelcome,
  sendPasswordReset,
  sendPurchaseReceipt,
  sendRefundConfirmation,
  sendChargebackAlert,
};

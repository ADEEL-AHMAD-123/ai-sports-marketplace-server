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

// Reply-To — where a customer's reply lands. Never MAIL_FROM_EMAIL if
// that's a noreply address; direct to support instead.
const REPLY_TO = process.env.MAIL_SUPPORT_EMAIL || MAIL_FROM_EMAIL;

/**
 * Build the deliverability headers Gmail / Outlook / Yahoo look for on
 * transactional email. Without these, mail from a new domain gets the
 * "this looks suspicious" banner even when the content is clean.
 *
 * - `List-Unsubscribe` + `-Post` — RFC 8058 one-click unsubscribe.
 *   Gmail's 2024 sender requirements make this near-mandatory for any
 *   bulk-shaped sender. Even purely transactional email benefits.
 * - `Auto-Submitted: auto-generated` — RFC 3834 marker that says
 *   "this is a machine-sent transactional message, don't reply-to-all
 *   or bounce-loop." Suppresses out-of-office auto-replies.
 * - `X-Entity-Ref-ID` — cross-references our internal category so we
 *   can find deliverability issues by type in Postmaster Tools.
 * - `Feedback-ID` — Gmail Postmaster Tools tracker format:
 *   `<campaign>:<customer>:<mailer-id>:<sender-id>`. Lets us monitor
 *   per-category spam rates in Postmaster once the domain qualifies
 *   (>~5k emails/day). Harmless below that threshold.
 */
const buildDeliverabilityHeaders = ({ category, to }) => {
  const unsubMailto = `mailto:${REPLY_TO}?subject=unsubscribe`;
  return {
    'List-Unsubscribe':      `<${unsubMailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Auto-Submitted':        'auto-generated',
    'X-Entity-Ref-ID':       category || 'transactional',
    'Feedback-ID':           `${category || 'txn'}:edgeai:mailer:edgeai-prod`,
  };
};

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
        from:      FROM,
        reply_to:  { email: REPLY_TO, name: MAIL_FROM_NAME },
        to:        [{ email: to }],
        subject,
        html,
        text,
        category,           // Mailtrap dashboard tag
        headers: buildDeliverabilityHeaders({ category, to }),
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

const sendPurchaseReceipt = ({
  to, name, packLabel, credits, perCreditUSD,
  subtotalUSD, taxUSD, amountUSD, newBalance,
  cardBrand, cardLast4,
  invoiceNumber, invoicePdfUrl, invoiceHostedUrl, invoiceDate,
  sessionId,
}) =>
  send({
    to, category: 'invoice',
    ...templates.purchaseReceipt({
      name, packLabel, credits, perCreditUSD,
      subtotalUSD, taxUSD, amountUSD, newBalance,
      cardBrand, cardLast4,
      invoiceNumber, invoicePdfUrl, invoiceHostedUrl, invoiceDate,
      sessionId,
    }),
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

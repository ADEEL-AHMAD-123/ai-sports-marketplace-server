/**
 * templates.js — Email templates as pure functions
 *
 * Each template returns { subject, html, text } and takes plain object
 * inputs — no template engine, no external files, no partials. Keeps the
 * whole email surface reviewable in one place and free of surprises.
 *
 * All templates share a common shell defined in _shell() so brand tweaks
 * happen in one place. Text versions are hand-written (not stripped HTML)
 * for readability in text-only clients and better deliverability.
 */

const BRAND = {
  name:       'EdgeAI',
  url:        process.env.FRONTEND_URL || 'https://edgeai.bet',
  supportEmail: process.env.MAIL_SUPPORT_EMAIL || 'support@edgeai.bet',
  // Support phone — optional. Only rendered if MAIL_SUPPORT_PHONE is set.
  // Format however you want in the env var; we'll strip whitespace for
  // the tel: link automatically.
  supportPhone: process.env.MAIL_SUPPORT_PHONE || '',
  // Physical mailing address — required by CAN-SPAM (US) and helpful
  // for Gmail's deliverability heuristics. If MAIL_POSTAL_ADDRESS isn't
  // set, we omit the line rather than lie about a fake address.
  postalAddress: process.env.MAIL_POSTAL_ADDRESS || '',
  color:      '#22c55e',
  darkBg:     '#0f1418',
  lightBg:    '#f8fafc',
  textPrim:   '#0f172a',
  textSub:    '#475569',
  textMuted:  '#94a3b8',
};

// Strip non-digits (except leading +) for a tel: link. "(415) 555-0123"
// becomes "+14155550123" which is what phones actually need to dial.
const telHref = (raw) => {
  if (!raw) return '';
  return String(raw).replace(/(?!^\+)[^\d]/g, '');
};

// Plain-text contact block, appended to every template's `text` output
// so plain-text mail clients (and screen readers) see the same contact
// info as HTML clients.
const textFooter = () => {
  const lines = ['', '— Contact —', `Email: ${BRAND.supportEmail}`];
  if (BRAND.supportPhone)  lines.push(`Phone: ${BRAND.supportPhone}`);
  lines.push(`Web:   ${BRAND.url}`);
  if (BRAND.postalAddress) lines.push('', BRAND.postalAddress);
  lines.push('', 'You received this email because an EdgeAI account was created with this address.');
  lines.push(`Unsubscribe: mailto:${BRAND.supportEmail}?subject=unsubscribe`);
  return lines.join('\n');
};

const escapeHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

/**
 * Shell — inlines all styles because most email clients drop <style> tags.
 * Layout: 560px centered card, sans-serif, brand color for accents.
 */
const _shell = ({ preview, heading, bodyHtml, ctaLabel, ctaUrl, footerNote }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.lightBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:${BRAND.textPrim};">
<!-- Preview text (hidden in body but shown in inbox preview) -->
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preview || '')}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.lightBg};padding:32px 16px;">
  <tr>
    <td align="center">

      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <!-- Brand rail -->
        <tr><td style="height:4px;background:${BRAND.color};font-size:0;line-height:0;">&nbsp;</td></tr>

        <!-- Logo + brand name -->
        <tr>
          <td style="padding:28px 32px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="width:28px;height:28px;background:${BRAND.color};border-radius:6px;text-align:center;vertical-align:middle;color:#ffffff;font-size:14px;font-weight:600;line-height:28px;">E</td>
                <td style="padding-left:10px;font-size:16px;font-weight:600;color:${BRAND.textPrim};">${BRAND.name}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Heading -->
        <tr>
          <td style="padding:16px 32px 4px;">
            <h1 style="margin:0;font-size:22px;font-weight:600;color:${BRAND.textPrim};line-height:1.3;">${heading}</h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:12px 32px 24px;font-size:15px;line-height:1.6;color:${BRAND.textSub};">
            ${bodyHtml}
          </td>
        </tr>

        ${ctaUrl ? `
        <!-- CTA -->
        <tr>
          <td style="padding:0 32px 8px;" align="left">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:${BRAND.color};border-radius:8px;">
                  <a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:500;color:#0f1418;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 32px 0;font-size:12px;color:${BRAND.textMuted};line-height:1.5;">
            If the button doesn't work, copy and paste this link:<br>
            <a href="${ctaUrl}" style="color:${BRAND.textSub};word-break:break-all;">${ctaUrl}</a>
          </td>
        </tr>
        ` : ''}

        ${footerNote ? `
        <tr>
          <td style="padding:24px 32px 0;font-size:12px;color:${BRAND.textMuted};line-height:1.5;">
            ${footerNote}
          </td>
        </tr>
        ` : ''}

        <!-- Footer — real contact info + minimum required legal fields.
             Structured so email clients render the contact block cleanly
             and Gmail's classifier sees a legitimate transactional
             sender pattern (short, has physical address, clear reason
             for sending, one-click unsubscribe). -->
        <tr>
          <td style="padding:22px 32px 26px;border-top:1px solid #e5e7eb;font-size:11px;color:${BRAND.textMuted};line-height:1.55;">

            <!-- Contact block — visually distinct so it reads as "how to
                 reach us" rather than legalese. -->
            <p style="margin:0 0 6px;font-weight:500;color:${BRAND.textSub};">Contact ${BRAND.name}</p>
            <p style="margin:0 0 4px;">
              Email <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.textSub};text-decoration:none;">${escapeHtml(BRAND.supportEmail)}</a>
              ${BRAND.supportPhone ? `<br>Phone <a href="tel:${telHref(BRAND.supportPhone)}" style="color:${BRAND.textSub};text-decoration:none;">${escapeHtml(BRAND.supportPhone)}</a>` : ''}
              <br>Web <a href="${BRAND.url}" style="color:${BRAND.textSub};text-decoration:none;">${BRAND.url.replace(/^https?:\/\//, '')}</a>
            </p>

            ${BRAND.postalAddress ? `<p style="margin:12px 0 0;">${escapeHtml(BRAND.postalAddress)}</p>` : ''}

            <p style="margin:14px 0 6px;">You received this email because an EdgeAI account was created with this address.</p>
            <p style="margin:0;">
              <a href="mailto:${BRAND.supportEmail}?subject=unsubscribe" style="color:${BRAND.textSub};">Unsubscribe</a>
            </p>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
</body>
</html>`;

// ─── Email templates ────────────────────────────────────────────────────

/**
 * Verify a newly-created email address. Blocks credit grants + spending
 * until the user clicks the link.
 */
const verifyEmail = ({ name, verifyUrl }) => ({
  subject: 'Verify your email — EdgeAI',
  html: _shell({
    preview:  'Confirm your email address to activate your EdgeAI account.',
    heading:  `Verify your email, ${escapeHtml(name)}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">Welcome to EdgeAI. One more step before your free scouting credits are unlocked — confirm you own this email address.</p>
      <p style="margin:0;">This link expires in <strong>24 hours</strong>.</p>
    `,
    ctaLabel: 'Verify email',
    ctaUrl:   verifyUrl,
    footerNote: `Didn't sign up for EdgeAI? You can safely ignore this email — no account will be created.`,
  }),
  text: [
    `Welcome to EdgeAI, ${name}.`,
    '',
    'Confirm you own this email address by opening this link (expires in 24 hours):',
    verifyUrl,
    '',
    "Didn't sign up? You can safely ignore this email.",
    '',
    '— EdgeAI',
    textFooter(),
  ].join('\n'),
});

/**
 * Sent immediately after successful verification — welcome + tips.
 */
const welcome = ({ name, credits }) => ({
  subject: `You're in, ${name} — ${credits} free credits waiting`,
  html: _shell({
    preview:  `Your ${credits} free EdgeAI credits are ready. Open the app to unlock your first scouting report.`,
    heading:  `You're in.`,
    bodyHtml: `
      <p style="margin:0 0 14px;">Your email is verified and <strong>${credits} free credits</strong> are sitting in your wallet. Each credit unlocks one AI scouting report.</p>
      <p style="margin:0 0 14px;">Not sure where to start? Sort today's slate by "Best Value" — that surfaces the picks with the strongest projected edge against the sportsbook line.</p>
      <p style="margin:0;">Bet responsibly, verify current lines at your book before wagering, and only stake what you can afford to lose.</p>
    `,
    ctaLabel: 'Open EdgeAI',
    ctaUrl:   BRAND.url,
  }),
  text: [
    `You're in, ${name}.`,
    '',
    `${credits} free credits are in your wallet. Each unlocks one AI scouting report.`,
    '',
    `Open EdgeAI: ${BRAND.url}`,
    '',
    'Bet responsibly — verify current lines at your book and only stake what you can afford to lose.',
    '',
    '— EdgeAI',
    textFooter(),
  ].join('\n'),
});

/**
 * Password reset link.
 */
const passwordReset = ({ name, resetUrl }) => ({
  subject: 'Reset your EdgeAI password',
  html: _shell({
    preview:  'Reset your EdgeAI password. Link expires in 1 hour.',
    heading:  'Reset your password',
    bodyHtml: `
      <p style="margin:0 0 14px;">Hi ${escapeHtml(name)}, we received a request to reset your EdgeAI password.</p>
      <p style="margin:0;">This link expires in <strong>1 hour</strong>. If you didn't request it, someone typed your email by mistake — you can safely ignore this email.</p>
    `,
    ctaLabel: 'Reset password',
    ctaUrl:   resetUrl,
    footerNote: 'For your security, we never send passwords or personal info by email.',
  }),
  text: [
    `Hi ${name},`,
    '',
    'Someone (hopefully you) requested a password reset. Open this link within 1 hour:',
    resetUrl,
    '',
    "Didn't request this? You can safely ignore this email.",
    '',
    '— EdgeAI',
    textFooter(),
  ].join('\n'),
});

/**
 * Receipt after successful purchase.
 */
const purchaseReceipt = ({ name, packLabel, credits, amountUSD, newBalance, sessionId }) => ({
  subject: `Receipt: ${credits} credits added to your EdgeAI wallet`,
  html: _shell({
    preview:  `${credits} credits added. New balance: ${newBalance}.`,
    heading:  'Payment received.',
    bodyHtml: `
      <p style="margin:0 0 14px;">Thanks for supporting EdgeAI, ${escapeHtml(name)}.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 12px;background:${BRAND.lightBg};border-radius:8px 8px 0 0;font-size:13px;color:${BRAND.textMuted};">Order</td>
          <td style="padding:8px 12px;background:${BRAND.lightBg};border-radius:8px 8px 0 0;font-size:13px;color:${BRAND.textPrim};text-align:right;font-weight:500;">${escapeHtml(packLabel)}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textMuted};">Credits added</td>
          <td style="padding:8px 12px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textPrim};text-align:right;font-weight:500;">+${credits}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textMuted};">Amount</td>
          <td style="padding:8px 12px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textPrim};text-align:right;font-weight:500;">$${Number(amountUSD).toFixed(2)} USD</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:${BRAND.lightBg};border-radius:0 0 8px 8px;font-size:13px;color:${BRAND.textMuted};">New balance</td>
          <td style="padding:8px 12px;background:${BRAND.lightBg};border-radius:0 0 8px 8px;font-size:13px;color:${BRAND.color};text-align:right;font-weight:600;">${newBalance} credits</td>
        </tr>
      </table>
      <p style="margin:0;font-size:12px;color:${BRAND.textMuted};">Reference: ${escapeHtml((sessionId || '').slice(-16))}</p>
    `,
    ctaLabel: 'Open EdgeAI',
    ctaUrl:   BRAND.url,
    footerNote: `Need a refund? Within 2 hours of purchase, self-serve from your wallet. After that, reply to this email and we'll help.`,
  }),
  text: [
    `Thanks for supporting EdgeAI, ${name}.`,
    '',
    `Order:         ${packLabel}`,
    `Credits added: +${credits}`,
    `Amount:        $${Number(amountUSD).toFixed(2)} USD`,
    `New balance:   ${newBalance} credits`,
    `Reference:     ${(sessionId || '').slice(-16)}`,
    '',
    `Open EdgeAI: ${BRAND.url}`,
    '',
    'Need a refund within 2 hours? Self-serve from your wallet. After that, reply here.',
    '',
    '— EdgeAI',
    textFooter(),
  ].join('\n'),
});

/**
 * Refund confirmation email.
 */
const refundConfirmation = ({ name, amountUSD, creditsReversed, refundId }) => ({
  subject: 'Refund confirmed — EdgeAI',
  html: _shell({
    preview:  `Your $${Number(amountUSD).toFixed(2)} refund has been issued.`,
    heading:  'Refund on the way.',
    bodyHtml: `
      <p style="margin:0 0 14px;">Hi ${escapeHtml(name)}, we've issued a refund of <strong>$${Number(amountUSD).toFixed(2)}</strong> USD. ${creditsReversed > 0 ? `${creditsReversed} credits have been deducted from your wallet.` : ''}</p>
      <p style="margin:0;">Depending on your card issuer, the money usually appears in your account within <strong>5–10 business days</strong>.</p>
      <p style="margin:14px 0 0;font-size:12px;color:${BRAND.textMuted};">Refund reference: ${escapeHtml(refundId || '')}</p>
    `,
  }),
  text: [
    `Hi ${name},`,
    '',
    `We've issued a refund of $${Number(amountUSD).toFixed(2)} USD.${creditsReversed > 0 ? ` ${creditsReversed} credits have been deducted from your wallet.` : ''}`,
    '',
    'Depending on your card issuer, the money usually appears in your account within 5–10 business days.',
    '',
    `Refund reference: ${refundId || ''}`,
    '',
    '— EdgeAI',
    textFooter(),
  ].join('\n'),
});

/**
 * Admin alert when a chargeback is opened. Not sent to end users.
 */
const chargebackAlert = ({ userEmail, disputeId, amountUSD, reason }) => ({
  subject: `[ALERT] Chargeback opened — ${userEmail}`,
  html: _shell({
    preview:  `Chargeback opened by ${userEmail} — $${amountUSD} — reason: ${reason}`,
    heading:  'Chargeback opened',
    bodyHtml: `
      <p style="margin:0 0 14px;">A chargeback was filed on a recent purchase.</p>
      <p style="margin:0;"><strong>User:</strong> ${escapeHtml(userEmail)}<br>
      <strong>Amount:</strong> $${Number(amountUSD).toFixed(2)} USD<br>
      <strong>Reason:</strong> ${escapeHtml(reason || 'not specified')}<br>
      <strong>Dispute ID:</strong> ${escapeHtml(disputeId)}</p>
      <p style="margin:14px 0 0;">The account has been auto-flagged and credit grants blocked. Review in Stripe.</p>
    `,
    ctaLabel: 'Open Stripe disputes',
    ctaUrl:   'https://dashboard.stripe.com/disputes',
  }),
  text: [
    `Chargeback opened by ${userEmail}.`,
    `Amount: $${amountUSD}`,
    `Reason: ${reason}`,
    `Dispute ID: ${disputeId}`,
    '',
    'Account auto-flagged. Review in Stripe: https://dashboard.stripe.com/disputes',
  ].join('\n'),
});

module.exports = {
  verifyEmail,
  welcome,
  passwordReset,
  purchaseReceipt,
  refundConfirmation,
  chargebackAlert,
};

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
 * Purchase invoice — designed to look like the formal receipts big SaaS
 * companies send (Stripe, Vercel, Linear, GitHub).
 *
 * Structure:
 *   1. Invoice number + issue date + big green PAID stamp.
 *   2. Billed to (customer) / From (EdgeAI + address).
 *   3. Itemized line-item table.
 *   4. Subtotal / tax / total block.
 *   5. Payment method (card brand + last4).
 *   6. Credits added + new wallet balance.
 *   7. CTA: view full invoice on Stripe / download PDF.
 *
 * All new fields fall back gracefully — the older single-arg call
 * signature that CreditService used before this refactor still works.
 */
const purchaseReceipt = ({
  name, packLabel, credits, perCreditUSD,
  subtotalUSD, taxUSD, amountUSD, newBalance,
  cardBrand, cardLast4,
  invoiceNumber, invoicePdfUrl, invoiceHostedUrl, invoiceDate,
  sessionId,
}) => {
  const $ = (v) => `$${Number(v || 0).toFixed(2)}`;
  const dateStr = (invoiceDate ? new Date(invoiceDate) : new Date())
    .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const brandTitle = cardBrand ? cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1) : null;
  const cardLabel  = brandTitle && cardLast4 ? `${brandTitle} ending in ${cardLast4}` : null;
  const invNumStr  = invoiceNumber || `EA-${(sessionId || '').slice(-8).toUpperCase()}`;
  const subTotal   = subtotalUSD ?? amountUSD;
  const unitPrice  = perCreditUSD || (amountUSD && credits ? amountUSD / credits : 0);

  // Reused table cell styles.
  const cellLabel     = `padding:10px 14px;font-size:13px;color:${BRAND.textMuted};border-bottom:1px solid #e5e7eb;`;
  const cellValue     = `padding:10px 14px;font-size:13px;color:${BRAND.textPrim};border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;`;
  const thStyle       = `padding:8px 14px;background:${BRAND.lightBg};font-size:10.5px;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.06em;font-weight:500;text-align:right;`;
  const thStyleLeft   = thStyle + 'text-align:left;';

  return {
    subject: `Invoice ${invNumStr} — EdgeAI (${$(amountUSD)})`,
    html: _shell({
      preview: `Receipt for ${credits} credits. ${$(amountUSD)} charged to ${cardLabel || 'your card'}. New balance: ${newBalance} credits.`,
      heading: 'Invoice',
      bodyHtml: `
        <!-- Invoice number + date, with PAID stamp on the right. -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td style="font-size:12px;color:${BRAND.textMuted};line-height:1.5;">
              <span style="color:${BRAND.textSub};font-weight:500;font-variant-numeric:tabular-nums;">${escapeHtml(invNumStr)}</span>
              <br>Issued ${dateStr}
            </td>
            <td style="text-align:right;vertical-align:top;">
              <span style="display:inline-block;padding:4px 12px;background:${BRAND.color};color:#ffffff;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Paid</span>
            </td>
          </tr>
        </table>

        <!-- Bill To + From columns -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
          <tr>
            <td width="50%" style="vertical-align:top;padding-right:8px;font-size:12px;color:${BRAND.textMuted};">
              <p style="margin:0 0 4px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND.textSub};font-size:10.5px;">Billed to</p>
              <p style="margin:0;color:${BRAND.textPrim};font-size:13px;font-weight:500;">${escapeHtml(name)}</p>
            </td>
            <td width="50%" style="vertical-align:top;padding-left:8px;font-size:12px;color:${BRAND.textMuted};">
              <p style="margin:0 0 4px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND.textSub};font-size:10.5px;">From</p>
              <p style="margin:0;color:${BRAND.textPrim};font-size:13px;font-weight:500;">${BRAND.name}</p>
              <p style="margin:2px 0 0;font-size:11.5px;color:${BRAND.textMuted};">${BRAND.url.replace(/^https?:\/\//, '')}</p>
            </td>
          </tr>
        </table>

        <!-- Itemized line items -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 4px;">
          <thead>
            <tr>
              <th style="${thStyleLeft}border-radius:6px 0 0 0;">Description</th>
              <th style="${thStyle}">Qty</th>
              <th style="${thStyle}">Unit</th>
              <th style="${thStyle}border-radius:0 6px 0 0;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding:14px;font-size:13px;color:${BRAND.textPrim};border-bottom:1px solid #e5e7eb;">
                <strong style="font-weight:500;">${escapeHtml(packLabel)}</strong>
                <br><span style="color:${BRAND.textMuted};font-size:12px;">${credits} credits × 1 unlock each</span>
              </td>
              <td style="padding:14px;font-size:13px;color:${BRAND.textPrim};border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${credits}</td>
              <td style="padding:14px;font-size:13px;color:${BRAND.textPrim};border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${$(unitPrice)}</td>
              <td style="padding:14px;font-size:13px;color:${BRAND.textPrim};border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;">${$(subTotal)}</td>
            </tr>
          </tbody>
        </table>

        <!-- Totals block, right-aligned. -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
          <tr>
            <td style="width:55%;"></td>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                <tr>
                  <td style="${cellLabel}">Subtotal</td>
                  <td style="${cellValue}">${$(subTotal)}</td>
                </tr>
                ${taxUSD > 0 ? `<tr>
                  <td style="${cellLabel}">Tax</td>
                  <td style="${cellValue}">${$(taxUSD)}</td>
                </tr>` : ''}
                <tr>
                  <td style="padding:12px 14px;font-size:14px;color:${BRAND.textPrim};font-weight:600;">Total paid</td>
                  <td style="padding:12px 14px;font-size:16px;color:${BRAND.textPrim};text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${$(amountUSD)}<span style="font-size:11px;color:${BRAND.textMuted};font-weight:400;"> USD</span></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        ${cardLabel ? `<p style="margin:0 0 18px;font-size:12.5px;color:${BRAND.textMuted};"><span style="color:${BRAND.textSub};font-weight:500;">Paid with</span> ${escapeHtml(cardLabel)}</p>` : ''}

        <!-- Credit balance highlight -->
        <div style="margin:6px 0 4px;padding:14px 16px;background:${BRAND.lightBg};border-radius:8px;border-left:3px solid ${BRAND.color};">
          <p style="margin:0;font-size:12.5px;color:${BRAND.textSub};">
            <strong style="color:${BRAND.color};font-size:14px;">+${credits} credits</strong> added to your wallet
          </p>
          <p style="margin:4px 0 0;font-size:12px;color:${BRAND.textMuted};">
            New balance: <strong style="color:${BRAND.textPrim};">${newBalance} credits</strong> — credits never expire.
          </p>
        </div>
      `,
      ctaLabel: invoiceHostedUrl ? 'View full invoice' : 'Open EdgeAI',
      ctaUrl:   invoiceHostedUrl || BRAND.url,
      footerNote: `
        ${invoicePdfUrl ? `<p style="margin:0 0 6px;">Download as PDF: <a href="${invoicePdfUrl}" style="color:${BRAND.textSub};">${invNumStr}.pdf</a></p>` : ''}
        <p style="margin:0;">Need a refund? Within 2 hours of purchase, self-serve from your wallet. After that, reply to this email.</p>
      `,
    }),
    text: [
      `Invoice ${invNumStr}`,
      `Issued: ${dateStr}`,
      '',
      'STATUS: PAID',
      '',
      `Billed to: ${name}`,
      `From:      ${BRAND.name}`,
      '',
      '─────────────────────────────────────',
      `Description:  ${packLabel}`,
      `              ${credits} credits × 1 unlock each`,
      `Quantity:     ${credits}`,
      `Unit price:   ${$(unitPrice)}`,
      '─────────────────────────────────────',
      `Subtotal:     ${$(subTotal)}`,
      taxUSD > 0 ? `Tax:          ${$(taxUSD)}` : null,
      `Total paid:   ${$(amountUSD)} USD`,
      '─────────────────────────────────────',
      '',
      cardLabel ? `Paid with:    ${cardLabel}` : null,
      `Credits added: +${credits}`,
      `New balance:   ${newBalance} credits`,
      '',
      invoiceHostedUrl ? `View invoice: ${invoiceHostedUrl}` : null,
      invoicePdfUrl    ? `PDF:          ${invoicePdfUrl}`   : null,
      `App:          ${BRAND.url}`,
      '',
      'Need a refund? Within 2 hours self-serve from your wallet. After that, reply here.',
      textFooter(),
    ].filter(Boolean).join('\n'),
  };
};

/**
 * Refund confirmation email — mirrors the invoice's formality so it
 * reads like a proper credit-note, not a support ticket update.
 */
const refundConfirmation = ({ name, amountUSD, creditsReversed, refundId }) => {
  const $ = (v) => `$${Number(v || 0).toFixed(2)}`;
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const refShort = refundId ? refundId.slice(-16) : '';

  return {
    subject: `Refund issued — ${$(amountUSD)} — EdgeAI`,
    html: _shell({
      preview: `Your ${$(amountUSD)} refund has been issued. Funds arrive in 5–10 business days.`,
      heading: 'Credit note',
      bodyHtml: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td style="font-size:12px;color:${BRAND.textMuted};line-height:1.5;">
              <span style="color:${BRAND.textSub};font-weight:500;font-variant-numeric:tabular-nums;">${escapeHtml(refShort || 'REFUND')}</span>
              <br>Issued ${dateStr}
            </td>
            <td style="text-align:right;vertical-align:top;">
              <span style="display:inline-block;padding:4px 12px;background:${BRAND.color};color:#ffffff;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Refunded</span>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 18px;font-size:14px;color:${BRAND.textPrim};">
          Hi ${escapeHtml(name)}, we've issued a refund on your recent EdgeAI purchase.
        </p>

        <!-- Refund summary block, styled like the invoice's totals card. -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 20px;">
          <tr>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textMuted};border-radius:6px 6px 0 0;">Refund amount</td>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:14px;color:${BRAND.textPrim};text-align:right;font-weight:600;font-variant-numeric:tabular-nums;border-radius:6px 6px 0 0;">${$(amountUSD)} USD</td>
          </tr>
          ${creditsReversed > 0 ? `<tr>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textMuted};border-top:1px solid #e5e7eb;">Credits reversed</td>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textPrim};text-align:right;font-weight:500;font-variant-numeric:tabular-nums;border-top:1px solid #e5e7eb;">−${creditsReversed}</td>
          </tr>` : ''}
          <tr>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:13px;color:${BRAND.textMuted};border-top:1px solid #e5e7eb;border-radius:0 0 6px 6px;">Refund reference</td>
            <td style="padding:10px 14px;background:${BRAND.lightBg};font-size:12px;color:${BRAND.textSub};text-align:right;font-family:'DM Mono',monospace;font-variant-numeric:tabular-nums;border-top:1px solid #e5e7eb;border-radius:0 0 6px 6px;">${escapeHtml(refundId || '—')}</td>
          </tr>
        </table>

        <p style="margin:0 0 8px;font-size:13px;color:${BRAND.textSub};">
          <strong style="color:${BRAND.textPrim};font-weight:500;">When will the money land?</strong>
        </p>
        <p style="margin:0;font-size:13px;color:${BRAND.textSub};">
          Depending on your card issuer, funds typically arrive back on the original card within
          <strong style="color:${BRAND.textPrim};">5–10 business days</strong>. The refund appears with the
          same statement descriptor as the original charge.
        </p>
      `,
      footerNote: 'If you don\'t see the refund within 10 business days, reply to this email with your reference number and we\'ll trace it with the payment network.',
    }),
    text: [
      `Credit note — issued ${dateStr}`,
      refShort ? `Reference: ${refShort}` : null,
      '',
      'STATUS: REFUNDED',
      '',
      `Hi ${name},`,
      '',
      `We've issued a refund of ${$(amountUSD)} USD on your recent EdgeAI purchase.`,
      '',
      '─────────────────────────────────────',
      `Refund amount:     ${$(amountUSD)} USD`,
      creditsReversed > 0 ? `Credits reversed:  -${creditsReversed}` : null,
      `Refund reference:  ${refundId || '—'}`,
      '─────────────────────────────────────',
      '',
      'When will the money land?',
      'Depending on your card issuer, funds typically arrive back on the original card within 5-10 business days.',
      '',
      "If you don't see the refund within 10 business days, reply to this email with your reference number and we'll trace it with the payment network.",
      textFooter(),
    ].filter(Boolean).join('\n'),
  };
};

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

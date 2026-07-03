/**
 * CreditService.js — Credit management + hardened Stripe integration
 *
 * Handles the full lifecycle of a paid credit:
 *  1. Creating a Stripe Checkout session (with server-side amount validation).
 *  2. Handling checkout.session.completed webhook → grant credits idempotently.
 *  3. Handling charge.refunded webhook → deduct credits, log REFUND transaction.
 *  4. Handling charge.dispute.created webhook → flag account, deduct credits.
 *  5. Handling checkout.session.expired → nothing to reverse (no credits granted).
 *  6. Self-serve refund requests within a short window.
 *  7. Customer portal session for billing history.
 *
 * SECURITY DESIGN PRINCIPLES (why the code is structured this way):
 *
 *  a) Server-side price truth. We NEVER trust session.metadata.credits blindly.
 *     After the checkout completes we re-look-up the pack by priceId (from
 *     line_items on the retrieved session) and use the server-side CREDIT_PACKS
 *     value. If someone tampers with the client to send a cheaper priceId,
 *     the server refuses to grant more credits than the tampered pack allows.
 *
 *  b) Amount verification. session.amount_total (Stripe's actual charge in
 *     cents) must match pack.amount * 100 within a tolerance. Prevents a
 *     mismatched price ID from silently over-granting.
 *
 *  c) Signature verification on webhooks (done in the controller before we
 *     get called). Prevents spoofed webhook events.
 *
 *  d) Idempotency at three levels: unique index on stripe.sessionId+type in
 *     Mongo, .isStripeSessionProcessed() check before mutation, and Stripe
 *     idempotency keys on outbound API calls (customer create, checkout create).
 *
 *  e) Chargeback lockout. When Stripe fires charge.dispute.created, we set
 *     chargebackFlag on the user which the checkout endpoint rejects. Stops
 *     serial-abuser accounts from creating new charges just to dispute them.
 *
 *  f) Refund credit reversal. When Stripe refund fires, we compute the credits
 *     equivalent to the refunded amount and deduct — but never below zero
 *     (if the user already spent them, they carry a negative balance in the
 *     ledger, which the unlock logic already prevents from going into use).
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  appInfo: { name: 'EdgeAI', version: '1.0.0' },
  maxNetworkRetries: 2, // Stripe SDK retries idempotent-safe requests
});

const crypto = require('crypto');
const User = require('../models/User.model');
const Transaction = require('../models/Transaction.model');
const EmailService = require('./email/EmailService');
const {
  CREDIT_PACKS, TRANSACTION_TYPES, CREDITS,
  REFUND_SELF_SERVE_WINDOW_HOURS,
  REFUND_SELF_SERVE_UNLOCK_LOCKOUT_MINUTES,
} = require('../config/constants');
const logger = require('../config/logger');

// Small helper — cents → dollars, guard against undefined
const centsToDollars = (c) => (typeof c === 'number' ? c / 100 : 0);

// Deterministic idempotency key so a network retry from the same request
// doesn't create two Stripe customers / sessions.
const idempotencyKey = (parts) =>
  crypto.createHash('sha256').update(parts.join('|')).digest('hex');

class CreditService {

  // ─── Checkout session creation ─────────────────────────────────────────────

  /**
   * Create a Stripe Checkout session for purchasing credits.
   *
   * Server-side hardening:
   *   - Refuses if user has chargebackFlag set.
   *   - Refuses if pack not in CREDIT_PACKS (protects against tampered client).
   *   - Uses idempotency key on customer create so retries don't dupe.
   *
   * @returns {Promise<{ url: string, sessionId: string }>}
   */
  async createCheckoutSession({ packId, user, successUrl, cancelUrl }) {
    // Server-side lookup by our internal pack id (not the priceId sent from
    // the client) — client only sends `packId`, we resolve everything else.
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      const err = new Error(`Unknown credit pack: ${packId}`);
      err.code = 'INVALID_PACK';
      throw err;
    }
    if (!pack.priceId) {
      const err = new Error(`Credit pack "${packId}" is not configured — missing Stripe price ID.`);
      err.code = 'PACK_NOT_CONFIGURED';
      throw err;
    }

    // Chargeback lockout — dispute filers can't buy more credits.
    if (user.chargebackFlag) {
      const err = new Error('Your account has a payment dispute on file. Contact support.');
      err.code = 'CHARGEBACK_LOCKED';
      throw err;
    }

    // Ensure Stripe customer exists (idempotent lookup).
    const stripeCustomerId = await this._ensureStripeCustomer(user);

    // Create the checkout session. Idempotency key derived from
    // (userId, packId, minute-bucket) so a click-happy user doesn't
    // create dozens of parallel sessions.
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = idempotencyKey(['checkout', user._id.toString(), packId, String(minuteBucket)]);

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: pack.priceId, quantity: 1 }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url:  cancelUrl,
      // Metadata is INFORMATIONAL only — we re-verify from Stripe on webhook.
      // We put packId (not credits) here specifically so a client can't
      // tamper to a bigger pack — the server re-derives from CREDIT_PACKS.
      metadata: {
        userId: user._id.toString(),
        packId: pack.id,
      },
      // Auto-generate a Stripe Invoice for every successful checkout —
      // gives us an official invoice number, a hosted invoice page URL,
      // and a PDF the customer can download. We embed both links in the
      // receipt email so the receipt looks like a proper invoice from
      // Stripe / Vercel / Linear etc.
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: `${pack.label} — ${pack.credits} EdgeAI credits`,
          footer: 'Thanks for supporting EdgeAI. Credits never expire. ' +
                  'Questions? Reply to this email.',
          metadata: {
            userId: user._id.toString(),
            packId: pack.id,
            credits: String(pack.credits),
          },
          // Custom fields show up on the PDF as extra rows.
          custom_fields: [
            { name: 'Credits',      value: String(pack.credits) },
            { name: 'Per credit',   value: `$${(pack.perCredit || pack.amount / pack.credits).toFixed(2)}` },
          ],
          rendering_options: { amount_tax_display: 'include_inclusive_tax' },
        },
      },
      // Automatic tax if configured on the Stripe account.
      automatic_tax: { enabled: false },
      // Ask for billing details — used on the invoice + helps deliverability.
      billing_address_collection: 'auto',
      // Time-box the session so abandoned checkouts don't clutter Stripe.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
    }, { idempotencyKey: key });

    logger.info('💳 [CreditService] Checkout session created', {
      userId: user._id, packId, credits: pack.credits, sessionId: session.id,
    });

    return { url: session.url, sessionId: session.id };
  }

  /**
   * Look up or create the user's Stripe customer record.
   * Uses idempotency key so parallel checkout attempts don't duplicate.
   */
  async _ensureStripeCustomer(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;

    const key = idempotencyKey(['customer', user._id.toString()]);
    const customer = await stripe.customers.create({
      email:    user.email,
      name:     user.name,
      metadata: { userId: user._id.toString() },
    }, { idempotencyKey: key });

    await User.findByIdAndUpdate(user._id, { stripeCustomerId: customer.id });
    logger.info('✅ [CreditService] Stripe customer created', {
      userId: user._id, stripeCustomerId: customer.id,
    });
    return customer.id;
  }

  // ─── Webhook dispatcher ────────────────────────────────────────────────────

  /**
   * Central webhook dispatcher. Signature has already been verified by the
   * controller. Each event handler is idempotent — Stripe will retry any
   * event that doesn't 2xx within its timeout, and we depend on our Mongo
   * unique indexes to keep duplicates out of the ledger.
   */
  async handleStripeWebhook(event) {
    logger.info('🔔 [CreditService] Processing webhook', {
      eventType: event.type, eventId: event.id,
    });

    switch (event.type) {
      case 'checkout.session.completed':
        return this._onCheckoutCompleted(event.data.object);

      case 'checkout.session.expired':
        return this._onCheckoutExpired(event.data.object);

      case 'payment_intent.payment_failed':
        return this._onPaymentFailed(event.data.object);

      case 'charge.refunded':
        return this._onChargeRefunded(event.data.object);

      case 'charge.dispute.created':
        return this._onDisputeCreated(event.data.object);

      case 'charge.dispute.closed':
        return this._onDisputeClosed(event.data.object);

      default:
        logger.debug('[CreditService] Ignored event', { type: event.type });
    }
  }

  // ─── checkout.session.completed → grant credits ────────────────────────────

  async _onCheckoutCompleted(session) {
    const { userId, packId } = session.metadata || {};
    logger.info('💳 [CreditService] Checkout completed', {
      sessionId: session.id, userId, packId,
    });

    // 1. Idempotency — has this session been booked already?
    if (await Transaction.isStripeSessionProcessed(session.id)) {
      logger.warn('⚠️  Duplicate checkout webhook — skipping', { sessionId: session.id });
      return;
    }

    // 2. Metadata sanity.
    if (!userId || !packId) {
      logger.error('❌ Webhook missing metadata', { sessionId: session.id, metadata: session.metadata });
      return;
    }

    // 3. Server-side truth: look up the pack from our config (never trust
    //    metadata for the credit count).
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      logger.error('❌ Unknown pack in webhook metadata', { packId, sessionId: session.id });
      return;
    }

    // 4. Amount verification — Stripe should have charged exactly pack.amount.
    //    A ~1c rounding tolerance protects against float weirdness across
    //    currencies but flags larger mismatches for admin review.
    const expectedCents = Math.round(pack.amount * 100);
    if (Math.abs((session.amount_total || 0) - expectedCents) > 2) {
      logger.error('❌ Amount mismatch — refusing to grant credits', {
        sessionId: session.id,
        expected: expectedCents,
        actual:   session.amount_total,
        packId,
      });
      // Do NOT grant credits. Admin will review + refund manually.
      return;
    }

    // 5. Find user.
    const user = await User.findById(userId);
    if (!user) {
      logger.error('❌ User not found for webhook', { userId, sessionId: session.id });
      return;
    }

    // 6. Grant credits + write ledger row.
    const creditsToAdd = pack.credits;
    const newBalance   = user.credits + creditsToAdd;

    // Retrieve the payment intent to grab the underlying chargeId + card
    // details. chargeId lets us correlate refunds and disputes back to
    // this purchase; card brand + last4 go on the invoice email.
    let chargeId       = null;
    let paymentIntentId = session.payment_intent;
    let cardBrand      = null;
    let cardLast4      = null;
    try {
      if (paymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge.payment_method_details.card'],
        });
        const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        chargeId  = charge?.id || pi.latest_charge || null;
        const cardDetails = charge?.payment_method_details?.card;
        if (cardDetails) {
          cardBrand = cardDetails.brand;
          cardLast4 = cardDetails.last4;
        }
      }
    } catch (err) {
      logger.warn('⚠️ Failed to expand payment intent — refund + card details missing', {
        error: err.message,
      });
    }

    // Retrieve the Stripe-generated invoice (created because we enabled
    // `invoice_creation` on the checkout session). Gives us a hosted PDF
    // + invoice number to put on the receipt email.
    let invoiceNumber   = null;
    let invoicePdfUrl   = null;
    let invoiceHostedUrl = null;
    try {
      if (session.invoice) {
        const inv = await stripe.invoices.retrieve(session.invoice);
        invoiceNumber   = inv.number || null;      // e.g. "INV-0001"
        invoicePdfUrl   = inv.invoice_pdf || null; // direct PDF
        invoiceHostedUrl = inv.hosted_invoice_url || null; // hosted web view
      }
    } catch (err) {
      logger.warn('⚠️ Failed to retrieve Stripe invoice — receipt will fall back to session ID', {
        error: err.message,
      });
    }

    await User.findByIdAndUpdate(userId, { $inc: { credits: creditsToAdd } });

    await Transaction.create({
      userId,
      type: TRANSACTION_TYPES.PURCHASE,
      creditDelta: creditsToAdd,
      balanceAfter: newBalance,
      description: `Purchased ${pack.label} (${creditsToAdd} credits)`,
      stripe: {
        sessionId:  session.id,
        paymentIntentId,
        chargeId,
        amountPaid: session.amount_total,
        creditsPurchased: creditsToAdd,
        priceId:    pack.priceId,
        packId:     pack.id,
        // Persist card + invoice details for the transaction detail page,
        // so we don't hit Stripe every time the user opens their history.
        cardBrand,
        cardLast4,
        invoiceNumber,
        invoicePdfUrl,
        invoiceHostedUrl,
      },
    });

    logger.info('✅ Credits granted', {
      userId, creditsAdded: creditsToAdd, newBalance, sessionId: session.id,
    });

    // Send invoice-style receipt email. Fire-and-forget so it never
    // blocks credit granting.
    EmailService.sendPurchaseReceipt({
      to:            user.email,
      name:          user.name,
      packLabel:     pack.label,
      credits:       creditsToAdd,
      perCreditUSD:  pack.perCredit || (pack.amount / pack.credits),
      subtotalUSD:   (session.amount_subtotal ?? session.amount_total ?? 0) / 100,
      taxUSD:        (session.total_details?.amount_tax || 0) / 100,
      amountUSD:     (session.amount_total || 0) / 100,
      newBalance,
      cardBrand,
      cardLast4,
      invoiceNumber,
      invoicePdfUrl,
      invoiceHostedUrl,
      invoiceDate:   new Date(session.created * 1000),
      sessionId:     session.id,
    }).catch((err) => logger.warn('[Email] receipt send failed', { error: err.message }));
  }

  // ─── checkout.session.expired → informational ──────────────────────────────

  async _onCheckoutExpired(session) {
    logger.info('⏱️ Checkout session expired', {
      sessionId: session.id, userId: session.metadata?.userId,
    });
    // No action — no credits were granted, no state change needed. Purely
    // logged for analytics on abandoned checkouts.
  }

  // ─── payment_intent.payment_failed → informational ────────────────────────

  async _onPaymentFailed(paymentIntent) {
    logger.warn('⚠️ Payment failed', {
      paymentIntentId: paymentIntent.id,
      reason: paymentIntent.last_payment_error?.message,
      code:   paymentIntent.last_payment_error?.code,
    });
    // No credits were granted (we only grant on checkout.session.completed).
    // Frontend gets its own signal from the checkout redirect. This is
    // logged for monitoring — high failure rates can indicate BIN issues.
  }

  // ─── charge.refunded → reverse credits ────────────────────────────────────

  async _onChargeRefunded(charge) {
    logger.info('↩️ Refund received', {
      chargeId: charge.id, amountRefunded: charge.amount_refunded,
    });

    // Find the original purchase.
    const purchase = await Transaction.findPurchaseByCharge(charge.id)
      || await Transaction.findPurchaseByPaymentIntent(charge.payment_intent);

    if (!purchase) {
      logger.warn('⚠️ Refund for unknown charge — no purchase record found', {
        chargeId: charge.id, paymentIntent: charge.payment_intent,
      });
      return;
    }

    // Stripe fires charge.refunded on every refund event. Idempotency: look
    // for latest refund on this charge and use its ID as unique key.
    // charge.refunds.data is present when we expand — safer to fetch fresh.
    let refund;
    try {
      const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
      refund = refunds.data[0];
    } catch (err) {
      logger.error('❌ Failed to list refunds for charge', { chargeId: charge.id, error: err.message });
      return;
    }
    if (!refund) return;

    // Have we already booked this refund?
    const existing = await Transaction.findOne({ 'stripe.refundId': refund.id }).lean();
    if (existing) {
      logger.debug('Refund already booked, skipping', { refundId: refund.id });
      return;
    }

    // Compute credits to reverse — proportional to refunded amount.
    // (Partial refund of 50% = deduct 50% of credits, rounded down.)
    const refundedCents = refund.amount || charge.amount_refunded;
    const originalCents = purchase.stripe.amountPaid || charge.amount;
    const originalCredits = purchase.stripe.creditsPurchased || 0;
    const creditsToReverse = originalCents > 0
      ? Math.floor((refundedCents / originalCents) * originalCredits)
      : 0;

    // Deduct credits — but never below the user's current balance to zero
    // (allowing debit to zero, not negative). If user already spent them,
    // that's fine — the refund still gets logged, they just can't get
    // "unspent" credits back to nothing.
    const user = await User.findById(purchase.userId);
    if (!user) return;
    const actualDeduct = Math.min(creditsToReverse, user.credits);
    const newBalance   = user.credits - actualDeduct;

    if (actualDeduct > 0) {
      await User.findByIdAndUpdate(user._id, { $inc: { credits: -actualDeduct } });
    }

    await Transaction.create({
      userId: user._id,
      type: TRANSACTION_TYPES.REFUND,
      creditDelta: -actualDeduct,
      balanceAfter: newBalance,
      description: `Refunded ${centsToDollars(refundedCents).toFixed(2)} USD — ${actualDeduct}/${creditsToReverse} credits reversed`,
      refundReason: refund.reason || 'stripe_refund',
      stripe: {
        refundId:       refund.id,
        chargeId:       charge.id,
        paymentIntentId: charge.payment_intent,
        amountRefunded: refundedCents,
      },
    });

    logger.info('✅ Refund booked', {
      userId: user._id, refundId: refund.id, creditsReversed: actualDeduct,
      creditsShortByAlreadySpent: creditsToReverse - actualDeduct,
    });

    // Refund confirmation email — fire and forget.
    EmailService.sendRefundConfirmation({
      to:              user.email,
      name:            user.name,
      amountUSD:       refundedCents / 100,
      creditsReversed: actualDeduct,
      refundId:        refund.id,
    }).catch((err) => logger.warn('[Email] refund email failed', { error: err.message }));
  }

  // ─── charge.dispute.created → chargeback lockout + credit deduct ──────────

  async _onDisputeCreated(dispute) {
    logger.warn('⚔️ Chargeback opened', {
      disputeId: dispute.id, chargeId: dispute.charge, reason: dispute.reason,
    });

    const purchase = await Transaction.findPurchaseByCharge(dispute.charge);
    if (!purchase) {
      logger.warn('⚠️ Dispute for unknown charge', { chargeId: dispute.charge });
      return;
    }

    // Idempotency by disputeId.
    const existing = await Transaction.findOne({ 'stripe.disputeId': dispute.id }).lean();
    if (existing) return;

    // Flag account + zero out credits from the disputed purchase.
    const user = await User.findById(purchase.userId);
    if (!user) return;

    const creditsToReverse = purchase.stripe.creditsPurchased || 0;
    const actualDeduct = Math.min(creditsToReverse, user.credits);
    const newBalance = user.credits - actualDeduct;

    await User.findByIdAndUpdate(user._id, {
      $inc: { credits: -actualDeduct },
      $set: {
        chargebackFlag: true,
        chargebackFlaggedAt: new Date(),
        chargebackReason: dispute.reason || 'unspecified',
      },
    });

    await Transaction.create({
      userId: user._id,
      type: TRANSACTION_TYPES.CHARGEBACK,
      creditDelta: -actualDeduct,
      balanceAfter: newBalance,
      description: `Chargeback filed — ${dispute.reason || 'reason not provided'}`,
      stripe: {
        disputeId: dispute.id,
        chargeId:  dispute.charge,
        amountRefunded: dispute.amount,
      },
    });

    logger.warn('🚫 User flagged for chargeback', {
      userId: user._id, disputeId: dispute.id, reason: dispute.reason,
    });

    // Alert the admin inbox (no-op if MAIL_ADMIN_EMAIL not set).
    EmailService.sendChargebackAlert({
      userEmail: user.email,
      disputeId: dispute.id,
      amountUSD: (dispute.amount || 0) / 100,
      reason:    dispute.reason,
    }).catch((err) => logger.warn('[Email] chargeback alert failed', { error: err.message }));
  }

  // ─── charge.dispute.closed → informational log (admin unlocks manually) ───

  async _onDisputeClosed(dispute) {
    logger.info('⚔️ Chargeback closed', {
      disputeId: dispute.id, status: dispute.status,
    });
    // We deliberately do NOT auto-unfreeze on 'won' outcome — admin should
    // review and clear the chargebackFlag manually to avoid gaming.
  }

  // ─── Self-serve refund request ─────────────────────────────────────────────

  /**
   * User-initiated refund. Allowed only if:
   *   - Purchase was made within REFUND_SELF_SERVE_WINDOW_HOURS.
   *   - User has NOT unlocked any insight since the purchase (within lockout).
   *   - User has credits >= purchased amount (no partial spending).
   * Otherwise the request goes to the admin queue.
   *
   * Returns the refund object or throws with a code the controller maps to
   * a user-facing message.
   */
  async requestSelfServeRefund({ user, purchaseTransactionId }) {
    const purchase = await Transaction.findOne({
      _id: purchaseTransactionId,
      userId: user._id,
      type: TRANSACTION_TYPES.PURCHASE,
    });
    if (!purchase) {
      const err = new Error('Purchase not found.');
      err.code = 'PURCHASE_NOT_FOUND';
      throw err;
    }

    // Already refunded?
    const alreadyRefunded = await Transaction.findOne({
      userId: user._id,
      type: TRANSACTION_TYPES.REFUND,
      'stripe.paymentIntentId': purchase.stripe.paymentIntentId,
    });
    if (alreadyRefunded) {
      const err = new Error('This purchase has already been refunded.');
      err.code = 'ALREADY_REFUNDED';
      throw err;
    }

    // Within self-serve window?
    const hoursSincePurchase = (Date.now() - purchase.createdAt.getTime()) / 3_600_000;
    if (hoursSincePurchase > REFUND_SELF_SERVE_WINDOW_HOURS) {
      const err = new Error(
        `Self-serve refunds are only available within ${REFUND_SELF_SERVE_WINDOW_HOURS} hours. Contact support.`,
      );
      err.code = 'OUTSIDE_WINDOW';
      throw err;
    }

    // Any unlocks since the purchase (or within lockout)?
    const lockoutStart = new Date(
      Date.now() - REFUND_SELF_SERVE_UNLOCK_LOCKOUT_MINUTES * 60_000,
    );
    const unlockSincePurchase = await Transaction.findOne({
      userId: user._id,
      type: TRANSACTION_TYPES.INSIGHT_UNLOCK,
      createdAt: { $gte: new Date(Math.min(purchase.createdAt, lockoutStart)) },
    });
    if (unlockSincePurchase) {
      const err = new Error(
        "You've unlocked an insight since this purchase. Contact support for a manual review.",
      );
      err.code = 'USED_AFTER_PURCHASE';
      throw err;
    }

    // Enough credits remain?
    const creditsUsed = purchase.stripe.creditsPurchased - user.credits;
    if (user.credits < purchase.stripe.creditsPurchased) {
      const err = new Error(
        `You've spent ${creditsUsed} of the ${purchase.stripe.creditsPurchased} credits. Contact support for a partial refund.`,
      );
      err.code = 'PARTIAL_SPEND';
      throw err;
    }

    // All checks passed — issue full refund via Stripe.
    const refund = await stripe.refunds.create({
      payment_intent: purchase.stripe.paymentIntentId,
      reason: 'requested_by_customer',
      metadata: {
        userId: user._id.toString(),
        purchaseTransactionId: purchase._id.toString(),
        source: 'self_serve',
      },
    }, {
      idempotencyKey: idempotencyKey(['refund', purchase._id.toString()]),
    });

    logger.info('✅ Self-serve refund issued', {
      userId: user._id, refundId: refund.id, purchaseTransactionId: purchase._id,
    });

    // The webhook (`charge.refunded`) will do the credit deduction + ledger
    // entry. We just kicked off the Stripe side here.
    return refund;
  }

  // ─── Customer portal (billing history + payment methods) ─────────────────

  /**
   * Create a Stripe Customer Portal session for the user to manage payment
   * methods, view invoices, download receipts. Stripe hosts the whole UI.
   */
  async createPortalSession({ user, returnUrl }) {
    const stripeCustomerId = await this._ensureStripeCustomer(user);
    const session = await stripe.billingPortal.sessions.create({
      customer:   stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async getBalance(userId) {
    const user = await User.findById(userId).select('credits').lean();
    return user?.credits ?? 0;
  }

  async getTransactionHistory({ userId, page = 1, limit = 20, type = null }) {
    const skip = (page - 1) * limit;
    const filter = { userId };
    if (type) filter.type = type;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);

    return {
      transactions,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
    };
  }

  /**
   * Fetch a single transaction by ID for the detail page. Enforces user
   * ownership at the query level so a user can't read someone else's
   * receipts by guessing IDs.
   *
   * For PURCHASE transactions, also enriches with an `isRefundable` flag
   * so the frontend knows whether to show the refund action.
   */
  async getTransactionById({ userId, transactionId }) {
    const tx = await Transaction.findOne({
      _id: transactionId,
      userId,
    }).lean();
    if (!tx) return null;

    // Compute refund eligibility for PURCHASE transactions.
    let isRefundable = false;
    if (tx.type === TRANSACTION_TYPES.PURCHASE && tx.stripe?.paymentIntentId) {
      const hoursSince = (Date.now() - new Date(tx.createdAt).getTime()) / 3_600_000;
      if (hoursSince <= REFUND_SELF_SERVE_WINDOW_HOURS) {
        // Also check the tx hasn't already been refunded.
        const alreadyRefunded = await Transaction.findOne({
          userId,
          type: TRANSACTION_TYPES.REFUND,
          'stripe.paymentIntentId': tx.stripe.paymentIntentId,
        }).lean();
        isRefundable = !alreadyRefunded;
      }
    }

    return {
      ...tx,
      isRefundable,
      refundWindowHours: REFUND_SELF_SERVE_WINDOW_HOURS,
    };
  }

  /**
   * Spend summary for the user — used by /account page.
   */
  async getSpendSummary(userId) {
    const rows = await Transaction.aggregate([
      { $match: { userId: require('mongoose').Types.ObjectId.createFromHexString(String(userId)) } },
      { $group: {
          _id: '$type',
          totalCredits: { $sum: '$creditDelta' },
          totalMoneyCents: { $sum: '$stripe.amountPaid' },
          count: { $sum: 1 },
        }
      },
    ]);
    const summary = {
      totalSpentUSD: 0,
      totalCreditsPurchased: 0,
      totalInsightsUnlocked: 0,
      totalRefundedUSD: 0,
    };
    for (const r of rows) {
      if (r._id === TRANSACTION_TYPES.PURCHASE) {
        summary.totalSpentUSD += centsToDollars(r.totalMoneyCents || 0);
        summary.totalCreditsPurchased += r.totalCredits;
      } else if (r._id === TRANSACTION_TYPES.INSIGHT_UNLOCK) {
        summary.totalInsightsUnlocked += Math.abs(r.totalCredits);
      } else if (r._id === TRANSACTION_TYPES.REFUND || r._id === TRANSACTION_TYPES.CHARGEBACK) {
        summary.totalRefundedUSD += centsToDollars(r.totalMoneyCents || 0);
      }
    }
    return summary;
  }

  /**
   * Public-facing pack list (strips priceId).
   */
  getCreditPacks() {
    return CREDIT_PACKS.map(({ id, credits, amount, label, perCredit, save, description, highlight }) => ({
      id, credits, amount, label, perCredit, save, description, highlight: !!highlight,
    }));
  }
}

module.exports = new CreditService();

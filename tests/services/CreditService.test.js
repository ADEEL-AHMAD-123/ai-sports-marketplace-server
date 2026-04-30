/**
 * CreditService.test.js — Unit tests for credit and Stripe webhook logic
 *
 * Critical tests:
 *  - Stripe webhook is idempotent (no double-crediting)
 *  - Credits are granted correctly
 *  - Invalid metadata doesn't crash
 */

const CreditService = require('../../src/services/CreditService');
const User = require('../../src/models/User.model');
const Transaction = require('../../src/models/Transaction.model');

jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Transaction.model');
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test' }) },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test', id: 'cs_test' }),
      },
    },
  }));
});

describe('CreditService', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── handleStripeWebhook ────────────────────────────────────────────────────

  describe('handleStripeWebhook()', () => {

    const buildCheckoutEvent = (overrides = {}) => ({
      type: 'checkout.session.completed',
      id: 'evt_test123',
      data: {
        object: {
          id: 'cs_test_session',
          payment_intent: 'pi_test',
          amount_total: 99, // cents
          metadata: {
            userId: 'user123',
            credits: '1',
            priceId: 'price_test',
            ...overrides.metadata,
          },
          ...overrides.session,
        },
      },
    });

    it('should grant credits when checkout.session.completed fires', async () => {
      Transaction.isStripeSessionProcessed = jest.fn().mockResolvedValue(false);
      User.findById = jest.fn().mockResolvedValue({ _id: 'user123', credits: 3 });
      User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      Transaction.create = jest.fn().mockResolvedValue({});

      await CreditService.handleStripeWebhook(buildCheckoutEvent());

      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'user123',
        { $inc: { credits: 1 } }
      );
      expect(Transaction.create).toHaveBeenCalled();
    });

    it('should NOT grant credits if session was already processed (idempotency)', async () => {
      Transaction.isStripeSessionProcessed = jest.fn().mockResolvedValue(true); // Already done

      await CreditService.handleStripeWebhook(buildCheckoutEvent());

      // Should NOT update user credits
      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(Transaction.create).not.toHaveBeenCalled();
    });

    it('should NOT grant credits if userId is missing from metadata', async () => {
      Transaction.isStripeSessionProcessed = jest.fn().mockResolvedValue(false);

      const event = buildCheckoutEvent({ metadata: { userId: '', credits: '1', priceId: 'price_test' } });
      await CreditService.handleStripeWebhook(event);

      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('should NOT grant credits if credits value is invalid', async () => {
      Transaction.isStripeSessionProcessed = jest.fn().mockResolvedValue(false);

      const event = buildCheckoutEvent({ metadata: { userId: 'user123', credits: 'abc', priceId: 'price_test' } });
      await CreditService.handleStripeWebhook(event);

      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('should NOT grant credits if user not found', async () => {
      Transaction.isStripeSessionProcessed = jest.fn().mockResolvedValue(false);
      User.findById = jest.fn().mockResolvedValue(null); // User deleted

      await CreditService.handleStripeWebhook(buildCheckoutEvent());

      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('should handle unrelated event types gracefully', async () => {
      const event = { type: 'payment_intent.created', data: { object: {} } };

      // Should not throw
      await expect(CreditService.handleStripeWebhook(event)).resolves.not.toThrow();
      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  // ── getCreditPacks ─────────────────────────────────────────────────────────

  describe('getCreditPacks()', () => {
    it('should return packs without exposing Stripe priceIds', () => {
      const packs = CreditService.getCreditPacks();

      expect(Array.isArray(packs)).toBe(true);
      packs.forEach((pack) => {
        // priceId should NOT be in the public response
        expect(pack.priceId).toBeUndefined();
        // These fields should be present
        expect(pack.id).toBeDefined();
        expect(pack.credits).toBeDefined();
        expect(pack.amount).toBeDefined();
        expect(pack.label).toBeDefined();
      });
    });
  });

  // ── getBalance ─────────────────────────────────────────────────────────────

  describe('getBalance()', () => {
    it('should return 0 if user not found', async () => {
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });

      const balance = await CreditService.getBalance('nonexistent');
      expect(balance).toBe(0);
    });

    it('should return the user credit balance', async () => {
      User.findById = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ credits: 7 }),
        }),
      });

      const balance = await CreditService.getBalance('user123');
      expect(balance).toBe(7);
    });
  });
});
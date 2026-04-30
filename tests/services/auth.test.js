/**
 * auth.test.js — Integration tests for auth and credit endpoints
 *
 * Tests the actual HTTP layer with mocked DB.
 * Covers: register, login, JWT protection, credit balance.
 */

const request = require('supertest');
const app = require('../../src/app');
const User = require('../../src/models/User.model');
const Transaction = require('../../src/models/Transaction.model');

jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Transaction.model');
jest.mock('../../src/config/redis', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(true),
  cacheDel: jest.fn().mockResolvedValue(1),
  redisClient: { quit: jest.fn() },
}));

describe('Auth Routes', () => {

  // ── Register ─────────────────────────────────────────────────────────────

  describe('POST /api/auth/register', () => {
    it('should return 400 for missing fields', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@test.com' }); // Missing name and password

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
    });

    it('should return 400 for weak password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Test User', email: 'test@test.com', password: 'weak' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Test', email: 'not-an-email', password: 'StrongPass1' });

      expect(res.status).toBe(400);
    });

    it('should return 409 when email already exists', async () => {
      User.findOne = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ email: 'existing@test.com' }),
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Test', email: 'existing@test.com', password: 'StrongPass1' });

      expect(res.status).toBe(409);
    });

    it('should register successfully with valid data', async () => {
      User.findOne = jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      const mockUser = {
        _id: 'user123',
        name: 'Test User',
        email: 'new@test.com',
        role: 'user',
        credits: 3,
        isEmailVerified: false,
        createdAt: new Date(),
        toPublicJSON: jest.fn().mockReturnValue({
          id: 'user123',
          name: 'Test User',
          email: 'new@test.com',
          credits: 3,
        }),
      };

      User.create = jest.fn().mockResolvedValue(mockUser);
      Transaction.create = jest.fn().mockResolvedValue({});

      const res = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Test User', email: 'new@test.com', password: 'StrongPass1' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toBeDefined();
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('should return 400 for missing fields', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@test.com' }); // Missing password

      expect(res.status).toBe(400);
    });

    it('should return 401 for wrong credentials', async () => {
      User.findOne = jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(null), // User not found
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'wrong@test.com', password: 'WrongPass1' });

      expect(res.status).toBe(401);
      // Should NOT reveal which field is wrong
      expect(res.body.message).toBe('Invalid email or password.');
    });
  });

  // ── Protected Routes ──────────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('should return 401 with malformed token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer notavalidtoken');

      expect(res.status).toBe(401);
    });
  });
});

// ── Credit Routes ─────────────────────────────────────────────────────────────

describe('Credit Routes', () => {
  it('GET /api/credits/packs should require auth', async () => {
    const res = await request(app).get('/api/credits/packs');
    expect(res.status).toBe(401);
  });

  it('GET /api/credits/balance should require auth', async () => {
    const res = await request(app).get('/api/credits/balance');
    expect(res.status).toBe(401);
  });

  it('GET /api/credits/transactions should require auth', async () => {
    const res = await request(app).get('/api/credits/transactions');
    expect(res.status).toBe(401);
  });
});

// ── Rate Limiting ─────────────────────────────────────────────────────────────

describe('Rate Limiting', () => {
  it('should apply rate limit to auth endpoints', async () => {
    // This test verifies the rate limiter headers are present
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@test.com', password: 'TestPass1' });

    // RateLimit headers should be present (from express-rate-limit)
    expect(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
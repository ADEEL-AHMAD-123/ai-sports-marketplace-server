const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../src/models/User.model');
jest.mock('../src/models/Insight.model');
jest.mock('../src/services/InsightService', () => ({
  generateInsight: jest.fn(),
}));
jest.mock('../src/config/redis', () => ({
  cacheGet: jest.fn().mockResolvedValue(null),
  cacheSet: jest.fn().mockResolvedValue(true),
  cacheDel: jest.fn().mockResolvedValue(1),
  redisClient: { quit: jest.fn() },
}));

const app = require('../src/app');
const User = require('../src/models/User.model');
const Insight = require('../src/models/Insight.model');
const InsightService = require('../src/services/InsightService');

describe('Insight Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

    const mockUser = {
      _id: 'user123',
      credits: 3,
      isActive: true,
      hasUnlockedInsight: jest.fn().mockReturnValue(false),
      hasEnoughCredits: jest.fn().mockReturnValue(true),
    };

    User.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockResolvedValue(mockUser),
    });
    Insight.findExisting = jest.fn().mockResolvedValue(null);
  });

  it('returns 422 without deducting credit when InsightService skips due to injury', async () => {
    const token = jwt.sign({ id: 'user123' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    InsightService.generateInsight.mockResolvedValue({
      insight: null,
      creditDeducted: false,
      error: 'Player listed as Out. Insight not generated.',
      injuryInfo: {
        skip: true,
        status: 'Out',
        severity: 'critical',
        reason: 'Ankle injury',
      },
    });

    const response = await request(app)
      .post('/api/insights/unlock')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sport: 'nba',
        eventId: 'event123',
        playerName: 'LeBron James',
        statType: 'points',
        bettingLine: 25.5,
        marketType: 'player_prop',
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Player listed as Out. Insight not generated.',
        creditDeducted: false,
        injuryInfo: expect.objectContaining({
          skip: true,
          status: 'Out',
        }),
      })
    );
  });
});
/**
 * InsightService.test.js
 *
 * Tests the most critical business logic:
 *  - Cold cache hit → NO credit deduction
 *  - Pre-flight failure (odds changed) → NO credit deduction
 *  - Pre-flight failure (market closed) → NO credit deduction
 *  - Previously unlocked insight → NO credit deduction
 *  - Successful new insight → 1 credit deducted
 *  - OpenAI failure → NO credit deducted + error returned
 *  - Refund logic works correctly
 */

var mockOpenAICreate;

// ── Mock all external dependencies ────────────────────────────────────────────
jest.mock('../../src/models/Insight.model');
jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Transaction.model');
jest.mock('../../src/models/PlayerProp.model');
jest.mock('../../src/models/Game.model', () => ({
  Game: {
    findOne: jest.fn(),
  },
}));
jest.mock('../../src/services/shared/adapterRegistry');
jest.mock('../../src/services/injuryService', () => ({
  getInjuryPromptContext: jest.fn(),
  getPlayerInjuryStatus: jest.fn(),
  isInjurySportSupported: jest.fn().mockReturnValue(true),
}));
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args) => mockOpenAICreate(...args),
      },
    },
  }));
});

const InsightService = require('../../src/services/InsightService');
const Insight = require('../../src/models/Insight.model');
const User = require('../../src/models/User.model');
const Transaction = require('../../src/models/Transaction.model');
const PlayerProp = require('../../src/models/PlayerProp.model');
const { Game } = require('../../src/models/Game.model');
const { getAdapter } = require('../../src/services/shared/adapterRegistry');
const { getInjuryPromptContext, getPlayerInjuryStatus } = require('../../src/services/injuryService');
const { INSIGHT_STATUS, CREDITS } = require('../../src/config/constants');

// ── Shared test fixtures ───────────────────────────────────────────────────────
const mockUser = {
  _id: 'user123',
  credits: 5,
  unlockedInsights: [],
  hasUnlockedInsight: jest.fn().mockReturnValue(false),
  hasEnoughCredits: jest.fn().mockReturnValue(true),
};

const mockInsightParams = {
  sport: 'nba',
  eventId: 'event123',
  playerName: 'LeBron James',
  statType: 'points',
  bettingLine: 25.5,
  marketType: 'player_prop',
  user: mockUser,
};

const mockAdapter = {
  fetchCurrentLine: jest.fn(),
  fetchPlayerStats: jest.fn().mockResolvedValue([]),
  applyFormulas: jest.fn().mockReturnValue({
    avgPoints: 28,
    recentStatValues: [28, 30, 25, 31, 27],
    focusStatAvg: 28,
    gamesAnalyzed: 5,
    trueShootingPct: 62,
    effectiveFGPct: 55,
    approxUSGPct: 30,
    avgRebounds: 8,
    avgAssists: 7,
    avgThrees: 1,
    avgMinutes: 35,
  }),
  buildPrompt: jest.fn().mockReturnValue('Mock prompt for LeBron James points over/under 25.5'),
};

const mockOpenAIResponse = {
  choices: [{ message: { content: '{"recommendation":"over","confidence":"high","summary":"LeBron projects over 25.5 points.","factors":["10-game avg 28 vs 25.5 line"],"risks":["Minutes volatility"],"dataQuality":"moderate"}' } }],
  usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
  model: 'gpt-4-turbo-preview',
};

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe('InsightService', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenAICreate = jest.fn();
    getAdapter.mockReturnValue(mockAdapter);
    mockUser.hasUnlockedInsight.mockReturnValue(false);
    mockUser.hasEnoughCredits.mockReturnValue(true);
    Game.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        homeTeam: { name: 'Los Angeles Lakers' },
        awayTeam: { name: 'Golden State Warriors' },
      }),
    });
    PlayerProp.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ apiSportsPlayerId: 2544 }),
    });
    getPlayerInjuryStatus.mockResolvedValue(null);
    getInjuryPromptContext.mockResolvedValue('');
  });

  // ── CACHE HIT ──────────────────────────────────────────────────────────────

  describe('Cold cache hit', () => {
    it('should return cached insight WITHOUT deducting credits', async () => {
      const cachedInsight = {
        _id: 'insight456',
        playerName: 'LeBron James',
        statType: 'points',
        bettingLine: 25.5,
        status: INSIGHT_STATUS.GENERATED,
        insightText: 'OVER — cached insight',
      };

      // findExisting returns a cached insight
      Insight.findExisting = jest.fn().mockResolvedValue(cachedInsight);
      // User hasn't unlocked it yet (first visit from cache)
      mockUser.hasUnlockedInsight.mockReturnValue(false);
      User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      Insight.findByIdAndUpdate = jest.fn().mockResolvedValue({});

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.creditDeducted).toBe(false);
      expect(result.insight).toEqual(cachedInsight);
      // OpenAI should NOT be called
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });

    it('should return cached insight for free if user already unlocked it', async () => {
      const cachedInsight = { _id: 'insight456', status: INSIGHT_STATUS.GENERATED };

      Insight.findExisting = jest.fn().mockResolvedValue(cachedInsight);
      mockUser.hasUnlockedInsight.mockReturnValue(true); // Already unlocked

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.creditDeducted).toBe(false);
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });
  });

  // ── PRE-FLIGHT FAILURES ────────────────────────────────────────────────────

  describe('Pre-flight check failures', () => {
    beforeEach(() => {
      Insight.findExisting = jest.fn().mockResolvedValue(null); // No cache
    });

    it('should NOT deduct credits when odds have changed significantly', async () => {
      // Current line is 27.0, user requested insight for line 25.5
      // Difference = 1.5 > ODDS_CHANGE_THRESHOLD (1.0) → fail
      mockAdapter.fetchCurrentLine.mockResolvedValue({ line: 27.0, isAvailable: true });

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.preflightFailed).toBe(true);
      expect(result.creditDeducted).toBe(false);
      expect(result.insight).toBeNull();
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });

    it('should NOT deduct credits when market is closed (player unavailable)', async () => {
      mockAdapter.fetchCurrentLine.mockResolvedValue({ line: null, isAvailable: false });

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.preflightFailed).toBe(true);
      expect(result.creditDeducted).toBe(false);
      expect(mockOpenAICreate).not.toHaveBeenCalled();
    });

    it('should NOT deduct credits when odds API is down during pre-flight', async () => {
      mockAdapter.fetchCurrentLine.mockRejectedValue(new Error('API timeout'));

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.preflightFailed).toBe(true);
      expect(result.creditDeducted).toBe(false);
    });

    it('should pass pre-flight when line change is within threshold', async () => {
      // Line moved from 25.5 to 25.0 — change of 0.5, within the 1.0 threshold
      mockAdapter.fetchCurrentLine.mockResolvedValue({ line: 25.0, isAvailable: true });

      // Mock successful AI response
      mockOpenAICreate.mockResolvedValue(mockOpenAIResponse);
      Insight.create = jest.fn().mockResolvedValue({ _id: 'newInsight', toObject: () => ({}) });
      User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      Transaction.create = jest.fn().mockResolvedValue({});

      const result = await InsightService.generateInsight(mockInsightParams);

      // Pre-flight should pass
      expect(result.preflightFailed).toBeUndefined();
    });
  });

  // ── SUCCESSFUL INSIGHT GENERATION ─────────────────────────────────────────

  describe('Successful insight generation', () => {
    beforeEach(() => {
      Insight.findExisting = jest.fn().mockResolvedValue(null);
      mockAdapter.fetchCurrentLine.mockResolvedValue({ line: 25.5, isAvailable: true });
      mockOpenAICreate.mockResolvedValue(mockOpenAIResponse);

      const mockCreatedInsight = {
        _id: 'newInsight789',
        playerName: 'LeBron James',
        statType: 'points',
        bettingLine: 25.5,
        recommendation: 'over',
        insightText: mockOpenAIResponse.choices[0].message.content,
        toObject: jest.fn().mockReturnThis(),
      };

      Insight.create = jest.fn().mockResolvedValue(mockCreatedInsight);
      User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      Transaction.create = jest.fn().mockResolvedValue({});
    });

    it('should deduct exactly 1 credit on successful insight generation', async () => {
      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.creditDeducted).toBe(true);

      // Verify credit deduction update was called correctly
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        mockUser._id,
        expect.objectContaining({
          $inc: { credits: -CREDITS.COST_PER_INSIGHT },
        })
      );
    });

    it('should create a transaction record on credit deduction', async () => {
      await InsightService.generateInsight(mockInsightParams);

      expect(Transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser._id,
          creditDelta: -CREDITS.COST_PER_INSIGHT,
        })
      );
    });

    it('should call OpenAI with a prompt containing the betting line', async () => {
      await InsightService.generateInsight(mockInsightParams);

      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
      // The prompt from our mock adapter contains the betting line
      expect(mockAdapter.buildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ bettingLine: 25.5 })
      );
    });

    it('should store the insight in MongoDB after generation', async () => {
      await InsightService.generateInsight(mockInsightParams);

      expect(Insight.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sport: 'nba',
          playerName: 'LeBron James',
          statType: 'points',
          bettingLine: 25.5,
          status: INSIGHT_STATUS.GENERATED,
        })
      );
    });
  });

  // ── OPENAI FAILURE ─────────────────────────────────────────────────────────

  describe('OpenAI failure handling', () => {
    beforeEach(() => {
      Insight.findExisting = jest.fn().mockResolvedValue(null);
      mockAdapter.fetchCurrentLine.mockResolvedValue({ line: 25.5, isAvailable: true });
    });

    it('should NOT deduct credits when OpenAI fails', async () => {
      mockOpenAICreate.mockRejectedValue(new Error('OpenAI rate limit exceeded'));

      const result = await InsightService.generateInsight(mockInsightParams);

      expect(result.creditDeducted).toBe(false);
      expect(result.insight).toBeNull();
      expect(result.error).toBeDefined();

      // No transaction should be created
      expect(Transaction.create).not.toHaveBeenCalled();
    });
  });

  // ── REFUND LOGIC ───────────────────────────────────────────────────────────

  describe('Credit refund', () => {
    it('should add 1 credit back when issueRefund is called', async () => {
      const mockUserForRefund = { _id: 'user123', credits: 2 };
      User.findById = jest.fn().mockResolvedValue(mockUserForRefund);
      User.findByIdAndUpdate = jest.fn().mockResolvedValue({});
      Transaction.create = jest.fn().mockResolvedValue({});

      await InsightService.issueRefund({
        userId: 'user123',
        insightId: 'insight456',
        reason: 'OpenAI API failure',
      });

      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        'user123',
        { $inc: { credits: CREDITS.COST_PER_INSIGHT } }
      );

      expect(Transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          creditDelta: +CREDITS.COST_PER_INSIGHT,
          type: 'refund',
        })
      );
    });
  });
});
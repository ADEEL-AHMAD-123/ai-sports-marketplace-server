/**
 * InsightOutcomeService.test.js
 *
 * Tests the persisted outcome grading logic:
 *  - persistOutcomesForEvents: finds ungraded insights, grades them, writes back
 *  - getOutcomeSummary: reads persisted fields, builds correct summary shape
 *  - postGameSync integration: calls persistOutcomesForEvents when games go FINAL
 */

// ── Mock all external I/O ─────────────────────────────────────────────────────
jest.mock('../../src/models/Insight.model', () => ({
  find: jest.fn(),
  bulkWrite: jest.fn(),
}));
jest.mock('../../src/models/Game.model', () => ({
  Game: { find: jest.fn(), findOne: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), countDocuments: jest.fn() },
  GAME_STATUS: { SCHEDULED: 'scheduled', LIVE: 'live', FINAL: 'final' },
}));
jest.mock('../../src/models/PlayerProp.model', () => ({
  find: jest.fn(),
  updateMany: jest.fn(),
  deleteMany: jest.fn(),
}));
jest.mock('../../src/services/shared/adapterRegistry', () => ({
  getAdapter: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({
  cacheDel: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Insight    = require('../../src/models/Insight.model');
const { Game }   = require('../../src/models/Game.model');
const PlayerProp = require('../../src/models/PlayerProp.model');
const { getAdapter } = require('../../src/services/shared/adapterRegistry');

// ── Helpers ───────────────────────────────────────────────────────────────────
const makeInsight = (overrides = {}) => ({
  _id: 'ins_' + Math.random().toString(36).slice(2),
  sport: 'nba',
  eventId: 'evt_abc',
  playerName: 'LeBron James',
  statType: 'points',
  bettingLine: 25.5,
  recommendation: 'over',
  confidenceScore: 82,
  edgePercentage: 12.4,
  status: 'generated',
  createdAt: new Date('2026-01-10T00:00:00Z'),
  outcomeResult: null,
  outcomeActual: null,
  outcomeGradedAt: null,
  ...overrides,
});

const makeGame = (overrides = {}) => ({
  _id: 'game_1',
  oddsEventId: 'evt_abc',
  sport: 'nba',
  startTime: new Date('2026-01-10T20:00:00Z'),
  status: 'final',
  ...overrides,
});

const service = require('../../src/services/InsightOutcomeService');

// ─────────────────────────────────────────────────────────────────────────────
// persistOutcomesForEvents
// ─────────────────────────────────────────────────────────────────────────────
describe('InsightOutcomeService.persistOutcomesForEvents', () => {
  it('returns zeroed result when eventIds is empty', async () => {
    const result = await service.persistOutcomesForEvents([]);
    expect(result).toEqual({ processed: 0, updated: 0, unresolved: 0 });
    expect(Insight.find).not.toHaveBeenCalled();
  });

  it('returns zeroed result when no matching insights found', async () => {
    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    const result = await service.persistOutcomesForEvents(['evt_xyz']);
    expect(result).toEqual({ processed: 0, updated: 0, unresolved: 0 });
  });

  it('grades a WIN and calls bulkWrite with correct fields', async () => {
    const insight = makeInsight();

    // Insight.find → returns the one insight
    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([insight]),
      }),
    });

    // Game.find → returns matching game
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeGame()]),
      }),
    });

    // PlayerProp.find → returns prop with apiSportsPlayerId
    PlayerProp.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'evt_abc',
          playerName: 'LeBron James',
          statType: 'points',
          apiSportsPlayerId: 'player_123',
        }]),
      }),
    });

    // Adapter returns a stat row with points = 28 (line was 25.5 → over → WIN)
    const mockAdapter = {
      fetchPlayerStats: jest.fn().mockResolvedValue([{
        gameDate: '2026-01-10',
        points: 28,
      }]),
    };
    getAdapter.mockReturnValue(mockAdapter);

    // Insight.bulkWrite returns success
    Insight.bulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    const result = await service.persistOutcomesForEvents(['evt_abc']);

    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.unresolved).toBe(0);

    const bulkArg = Insight.bulkWrite.mock.calls[0][0];
    expect(bulkArg).toHaveLength(1);
    const updateDoc = bulkArg[0].updateOne.update.$set;
    expect(updateDoc.outcomeResult).toBe('win');
    expect(updateDoc.outcomeActual).toBe(28);
    expect(updateDoc.outcomeGradedAt).toBeInstanceOf(Date);
  });

  it('grades a LOSS when actual is below the line for an over pick', async () => {
    const insight = makeInsight({ recommendation: 'over', bettingLine: 25.5 });

    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([insight]),
      }),
    });
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeGame()]),
      }),
    });
    PlayerProp.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'evt_abc',
          playerName: 'LeBron James',
          statType: 'points',
          apiSportsPlayerId: 'player_123',
        }]),
      }),
    });
    getAdapter.mockReturnValue({
      fetchPlayerStats: jest.fn().mockResolvedValue([{
        gameDate: '2026-01-10',
        points: 20, // under 25.5 → LOSS
      }]),
    });
    Insight.bulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    const result = await service.persistOutcomesForEvents(['evt_abc']);
    const updateDoc = Insight.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(updateDoc.outcomeResult).toBe('loss');
    expect(updateDoc.outcomeActual).toBe(20);
  });

  it('grades a PUSH when actual equals the line exactly', async () => {
    const insight = makeInsight({ recommendation: 'over', bettingLine: 25.5 });

    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([insight]),
      }),
    });
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeGame()]),
      }),
    });
    PlayerProp.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'evt_abc',
          playerName: 'LeBron James',
          statType: 'points',
          apiSportsPlayerId: 'player_123',
        }]),
      }),
    });
    getAdapter.mockReturnValue({
      fetchPlayerStats: jest.fn().mockResolvedValue([{
        gameDate: '2026-01-10',
        points: 25.5, // exact push
      }]),
    });
    Insight.bulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    await service.persistOutcomesForEvents(['evt_abc']);
    const updateDoc = Insight.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(updateDoc.outcomeResult).toBe('push');
    expect(updateDoc.outcomeActual).toBe(25.5);
  });

  it('marks unresolved when adapter returns no matching stat row', async () => {
    const insight = makeInsight();

    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([insight]),
      }),
    });
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeGame()]),
      }),
    });
    PlayerProp.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'evt_abc',
          playerName: 'LeBron James',
          statType: 'points',
          apiSportsPlayerId: 'player_123',
        }]),
      }),
    });
    getAdapter.mockReturnValue({
      fetchPlayerStats: jest.fn().mockResolvedValue([]), // no rows
    });
    Insight.bulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    const result = await service.persistOutcomesForEvents(['evt_abc']);
    const updateDoc = Insight.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(updateDoc.outcomeResult).toBe('unresolved');
    expect(updateDoc.outcomeActual).toBeNull();
    expect(result.unresolved).toBe(1);
  });

  it('handles UNDER recommendation correctly — win when actual < line', async () => {
    const insight = makeInsight({ recommendation: 'under', bettingLine: 25.5 });

    Insight.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([insight]),
      }),
    });
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeGame()]),
      }),
    });
    PlayerProp.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'evt_abc',
          playerName: 'LeBron James',
          statType: 'points',
          apiSportsPlayerId: 'player_123',
        }]),
      }),
    });
    getAdapter.mockReturnValue({
      fetchPlayerStats: jest.fn().mockResolvedValue([{
        gameDate: '2026-01-10',
        points: 18, // under 25.5 → WIN for under pick
      }]),
    });
    Insight.bulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    await service.persistOutcomesForEvents(['evt_abc']);
    const updateDoc = Insight.bulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(updateDoc.outcomeResult).toBe('win');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOutcomeSummary
// ─────────────────────────────────────────────────────────────────────────────
describe('InsightOutcomeService.getOutcomeSummary', () => {
  const buildInsightQuery = (items) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(items),
  });

  it('returns correct summary shape for graded insights', async () => {
    const now = new Date();
    const gradedInsights = [
      makeInsight({ outcomeResult: 'win', outcomeActual: 28, outcomeGradedAt: now, eventId: 'e1' }),
      makeInsight({ outcomeResult: 'win', outcomeActual: 30, outcomeGradedAt: now, eventId: 'e2' }),
      makeInsight({ outcomeResult: 'loss', outcomeActual: 20, outcomeGradedAt: now, eventId: 'e3' }),
    ];

    Insight.find.mockReturnValue(buildInsightQuery(gradedInsights));
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(gradedInsights.map((ins) => ({
          oddsEventId: ins.eventId,
          startTime: new Date(now.getTime() - 3600000), // 1h ago = started
          status: 'final',
        }))),
      }),
    });

    const summary = await service.getOutcomeSummary();

    expect(summary.graded).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.pushes).toBe(0);
    expect(summary.winRateExPush).toBeCloseTo(66.67, 0);
    expect(summary.byResult).toEqual({ win: 2, loss: 1, push: 0 });
    expect(summary.bySport).toBeDefined();
    expect(summary.byConfidence).toBeDefined();
  });

  it('includes sample arrays when includeSamples is true', async () => {
    const now = new Date();
    const insight = makeInsight({ outcomeResult: 'win', outcomeActual: 28, outcomeGradedAt: now, eventId: 'e1' });

    Insight.find.mockReturnValue(buildInsightQuery([insight]));
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'e1',
          startTime: new Date(now.getTime() - 3600000),
          status: 'final',
        }]),
      }),
    });

    const summary = await service.getOutcomeSummary({ includeSamples: true });
    expect(Array.isArray(summary.sampleResolved)).toBe(true);
    expect(summary.sampleResolved[0].playerName).toBe('LeBron James');
    expect(summary.sampleResolved[0].result).toBe('win');
  });

  it('returns zeros for empty insight set', async () => {
    Insight.find.mockReturnValue(buildInsightQuery([]));
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    const summary = await service.getOutcomeSummary();
    expect(summary.graded).toBe(0);
    expect(summary.wins).toBe(0);
    expect(summary.winRateExPush).toBeNull();
  });

  it('excludes insights whose game has not started yet', async () => {
    const futureGame = makeGame({ startTime: new Date(Date.now() + 10_000_000) });
    const insight = makeInsight({ outcomeResult: 'win', outcomeActual: 30, eventId: 'e_future' });

    Insight.find.mockReturnValue(buildInsightQuery([insight]));
    Game.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          oddsEventId: 'e_future',
          startTime: futureGame.startTime,
          status: 'scheduled',
        }]),
      }),
    });

    const summary = await service.getOutcomeSummary();
    // Game hasn't started so insight should not be included in graded count
    expect(summary.graded).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postGameSync integration: calls persistOutcomesForEvents on FINAL transitions
// ─────────────────────────────────────────────────────────────────────────────
describe('postGameSync — FINAL transition triggers outcome grading', () => {
  it('calls persistOutcomesForEvents with correct eventIds when games go FINAL', async () => {
    // Spy on the singleton instance method (no jest.mock needed — avoids hoisting)
    const spy = jest.spyOn(service, 'persistOutcomesForEvents').mockResolvedValue({
      processed: 1, updated: 1, unresolved: 0,
    });

    const now = new Date();
    const liveGame = {
      _id: 'game_live_1',
      sport: 'nba',
      oddsEventId: 'evt_live_abc',
      startTime: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      homeTeam: { name: 'Lakers' },
      awayTeam: { name: 'Warriors' },
    };

    let findCallCount = 0;
    Game.find.mockImplementation(() => {
      findCallCount++;
      // nba sport: call 1 = toMarkLive (empty), call 2 = toMarkFinal (liveGame)
      if (findCallCount === 2) {
        return { lean: jest.fn().mockResolvedValue([liveGame]) };
      }
      return { select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) };
    });

    Game.updateMany.mockResolvedValue({ modifiedCount: 1 });
    PlayerProp.updateMany.mockResolvedValue({ modifiedCount: 0 });

    const { runPostGameSync } = require('../../src/jobs/orchestrators/postGameSync.job.js');
    await runPostGameSync();

    expect(spy).toHaveBeenCalledWith(expect.arrayContaining(['evt_live_abc']));
    spy.mockRestore();
  });
});

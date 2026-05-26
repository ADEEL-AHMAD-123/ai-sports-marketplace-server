/**
 * outcomeCoverage.test.js
 *
 * The coverage job tops up system insights per (sport, stat type) for games
 * at final lock — bounded by a daily target, a global cap, and dedup against
 * props that already carry an insight.
 */

jest.mock('../../src/models/Game.model', () => ({
  Game: { find: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) },
  GAME_STATUS: { SCHEDULED: 'scheduled', LIVE: 'live', FINAL: 'final' },
}));
jest.mock('../../src/models/Insight.model', () => ({
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  find: jest.fn(),
}));
jest.mock('../../src/models/PlayerProp.model', () => ({ find: jest.fn() }));
jest.mock('../../src/services/InsightService', () => ({ generateInsight: jest.fn() }));
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { Game }       = require('../../src/models/Game.model');
const Insight        = require('../../src/models/Insight.model');
const PlayerProp     = require('../../src/models/PlayerProp.model');
const InsightService = require('../../src/services/InsightService');
const { runOutcomeCoverage } = require('../../src/jobs/outcomeCoverage.job');

// Chainable query stub — covers .select() / .sort() then a terminal .lean().
const chain = (result) => {
  const c = {};
  c.select = jest.fn(() => c);
  c.sort   = jest.fn(() => c);
  c.lean   = jest.fn(() => Promise.resolve(result));
  return c;
};

const NBA_GAME = { _id: 'g1', sport: 'nba', oddsEventId: 'evt1', startTime: new Date() };
const POINTS_PROP = {
  playerName: 'LeBron James', statType: 'points', line: 25.5,
  marketType: 'player_prop', apiSportsPlayerId: 'p1', injuryStatus: null,
};

describe('runOutcomeCoverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.updateOne.mockResolvedValue({});
  });

  it('generates a system insight for an uncovered prop at a lock-window game', async () => {
    Insight.countDocuments.mockResolvedValue(0);            // systemToday
    Game.find.mockReturnValue(chain([NBA_GAME]));
    Insight.aggregate.mockResolvedValue([]);                // no existing counts today
    PlayerProp.find.mockReturnValue(chain([POINTS_PROP]));
    Insight.find.mockReturnValue(chain([]));                // no existing insights (dedup)
    InsightService.generateInsight.mockResolvedValue({ insight: { _id: 'i1' }, cached: false });

    const result = await runOutcomeCoverage(new Date());

    expect(result.generated).toBe(1);
    expect(InsightService.generateInsight).toHaveBeenCalledTimes(1);
    expect(InsightService.generateInsight).toHaveBeenCalledWith(expect.objectContaining({
      sport: 'nba', eventId: 'evt1', statType: 'points',
      playerName: 'LeBron James', bettingLine: 25.5, generatedBy: 'system',
    }));
    // Game marked covered so later cycles skip it.
    expect(Game.updateOne).toHaveBeenCalledWith(
      { _id: 'g1' },
      { $set: { coverageDoneAt: expect.any(Date) } },
    );
  });

  it('skips entirely when the global daily cap is already reached', async () => {
    Insight.countDocuments.mockResolvedValue(120);          // == COVERAGE_DAILY_MAX

    const result = await runOutcomeCoverage(new Date());

    expect(result.capped).toBe(true);
    expect(Game.find).not.toHaveBeenCalled();
    expect(InsightService.generateInsight).not.toHaveBeenCalled();
  });

  it('does not generate for a stat type already at the daily target', async () => {
    Insight.countDocuments.mockResolvedValue(0);
    Game.find.mockReturnValue(chain([NBA_GAME]));
    // points already has 3 insights today (== COVERAGE_PER_TYPE_DAILY_TARGET)
    Insight.aggregate.mockResolvedValue([{ _id: { sport: 'nba', statType: 'points' }, n: 3 }]);
    PlayerProp.find.mockReturnValue(chain([POINTS_PROP]));
    Insight.find.mockReturnValue(chain([]));

    const result = await runOutcomeCoverage(new Date());

    expect(result.generated).toBe(0);
    expect(InsightService.generateInsight).not.toHaveBeenCalled();
  });

  it('skips a prop that already carries a generated insight (dedup)', async () => {
    Insight.countDocuments.mockResolvedValue(0);
    Game.find.mockReturnValue(chain([NBA_GAME]));
    Insight.aggregate.mockResolvedValue([]);
    PlayerProp.find.mockReturnValue(chain([POINTS_PROP]));
    // An insight already exists for exactly this prop.
    Insight.find.mockReturnValue(chain([
      { playerName: 'LeBron James', statType: 'points', bettingLine: 25.5 },
    ]));

    const result = await runOutcomeCoverage(new Date());

    expect(result.generated).toBe(0);
    expect(InsightService.generateInsight).not.toHaveBeenCalled();
    // Still marks the game covered — nothing left to do for it.
    expect(Game.updateOne).toHaveBeenCalled();
  });

  it('no-ops cleanly when there are no games at final lock', async () => {
    Insight.countDocuments.mockResolvedValue(0);
    Game.find.mockReturnValue(chain([]));

    const result = await runOutcomeCoverage(new Date());

    expect(result.generated).toBe(0);
    expect(InsightService.generateInsight).not.toHaveBeenCalled();
  });
});

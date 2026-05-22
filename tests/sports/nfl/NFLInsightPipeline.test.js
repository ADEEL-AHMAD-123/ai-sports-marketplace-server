/**
 * NFLInsightPipeline.test.js
 *
 * Verifies team form / rest-days context is computed from the durable
 * TeamGameResult store, and that the matchup block is omitted on a cold
 * start (no history yet) instead of emitting misleading "n/a" values.
 */

jest.mock('../../../src/models/TeamGameResult.model', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const TeamGameResult = require('../../../src/models/TeamGameResult.model');
const { getInsightContext } = require('../../../src/services/sports/nfl/NFLInsightPipeline');

const CHIEFS = 'Kansas City Chiefs';
const BILLS  = 'Buffalo Bills';

// A chainable query stub usable for both find() and findOne().
const chain = (result) => {
  const c = {};
  c.sort   = jest.fn(() => c);
  c.limit  = jest.fn(() => c);
  c.select = jest.fn(() => c);
  c.lean   = jest.fn(() => Promise.resolve(result));
  return c;
};

const teamOf = (q) => q?.$or?.[0]?.homeTeamName;

const GAME = {
  startTime: new Date('2026-01-18T18:00:00Z'),
  homeTeam: { name: CHIEFS },
  awayTeam: { name: BILLS },
};

describe('NFLInsightPipeline.getInsightContext', () => {
  beforeEach(() => jest.clearAllMocks());

  it('computes team form and rest days from TeamGameResult', async () => {
    const chiefsRows = [
      { homeTeamName: CHIEFS, awayTeamName: 'Denver Broncos',
        homeScore: 30, awayScore: 20, startTime: new Date('2026-01-11T18:00:00Z') },
      { homeTeamName: 'Las Vegas Raiders', awayTeamName: CHIEFS,
        homeScore: 24, awayScore: 27, startTime: new Date('2026-01-04T18:00:00Z') },
    ];
    const billsRows = [
      { homeTeamName: BILLS, awayTeamName: 'Miami Dolphins',
        homeScore: 21, awayScore: 17, startTime: new Date('2026-01-12T18:00:00Z') },
    ];

    TeamGameResult.find.mockImplementation((q) =>
      chain(teamOf(q) === CHIEFS ? chiefsRows : teamOf(q) === BILLS ? billsRows : []));
    TeamGameResult.findOne.mockImplementation((q) =>
      chain(teamOf(q) === CHIEFS ? chiefsRows[0] : teamOf(q) === BILLS ? billsRows[0] : null));

    const ctx = await getInsightContext({}, GAME);

    // Chiefs: PF (30 home + 27 away)/2 = 28.5 ; PA (20 + 24)/2 = 22
    expect(ctx.teamContext.homeForm).toEqual({
      games: 2, pointsForPerGame: 28.5, pointsAgainstPerGame: 22,
    });
    // Bills: single game, home 21-17
    expect(ctx.teamContext.awayForm).toEqual({
      games: 1, pointsForPerGame: 21, pointsAgainstPerGame: 17,
    });
    // Rest: Chiefs last game 7 days before kickoff, Bills 6 days
    expect(ctx.teamContext.homeRestDays).toBe(7);
    expect(ctx.teamContext.awayRestDays).toBe(6);
    expect(ctx.teamContext.restEdgeDays).toBe(1);
    expect(ctx.teamContext.hasShortRest).toBe(false);
    expect(ctx.gameContext.kickoffIso).toBe('2026-01-18T18:00:00.000Z');
  });

  it('flags short rest when a team played within the last 6 days', async () => {
    const chiefsRows = [
      { homeTeamName: CHIEFS, awayTeamName: 'Denver Broncos',
        homeScore: 28, awayScore: 24, startTime: new Date('2026-01-15T01:00:00Z') },
    ];
    TeamGameResult.find.mockImplementation((q) =>
      chain(teamOf(q) === CHIEFS ? chiefsRows : []));
    TeamGameResult.findOne.mockImplementation((q) =>
      chain(teamOf(q) === CHIEFS ? chiefsRows[0] : null));

    const ctx = await getInsightContext({}, GAME);
    // Chiefs played ~3.7 days before kickoff → short rest
    expect(ctx.teamContext.homeRestDays).toBeLessThan(6);
    expect(ctx.teamContext.hasShortRest).toBe(true);
  });

  it('omits teamContext entirely on a cold start (no history yet)', async () => {
    TeamGameResult.find.mockImplementation(() => chain([]));
    TeamGameResult.findOne.mockImplementation(() => chain(null));

    const ctx = await getInsightContext({}, GAME);
    expect(ctx.teamContext).toBeNull();
    // Kickoff context still works — it derives purely from game.startTime.
    expect(ctx.gameContext).not.toBeNull();
  });
});

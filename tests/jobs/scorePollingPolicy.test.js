/**
 * scorePollingPolicy.test.js
 *
 * Verifies /scores is only called when a started game could be finishing,
 * with a tighter cadence once games are in the "settle" band.
 */

const {
  shouldFetchScores,
  scorePollIntervalForGames,
} = require('../../src/jobs/sports/shared/scorePollingPolicy');

const NOW = new Date('2026-05-21T22:00:00Z');
const gameStartedMinsAgo = (m) => ({ startTime: new Date(NOW.getTime() - m * 60000) });
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000);

describe('scorePollIntervalForGames', () => {
  it('returns null when there are no games', () => {
    expect(scorePollIntervalForGames([], NOW)).toBeNull();
  });

  it('returns null when games have not started yet', () => {
    expect(scorePollIntervalForGames([{ startTime: new Date(NOW.getTime() + 3600000) }], NOW)).toBeNull();
  });

  it('returns the "live" interval (90m) for an in-progress game', () => {
    expect(scorePollIntervalForGames([gameStartedMinsAgo(60)], NOW)).toBe(90);
  });

  it('returns the tighter "settle" interval (25m) for a likely-finishing game', () => {
    expect(scorePollIntervalForGames([gameStartedMinsAgo(200)], NOW)).toBe(25);
  });

  it('settle tier wins when both live and settling games are present', () => {
    expect(scorePollIntervalForGames([gameStartedMinsAgo(60), gameStartedMinsAgo(200)], NOW)).toBe(25);
  });

  it('returns null once a game is long past the settle window', () => {
    expect(scorePollIntervalForGames([gameStartedMinsAgo(500)], NOW)).toBeNull();
  });
});

describe('shouldFetchScores', () => {
  it('is false when no game is in a finishable band', () => {
    expect(shouldFetchScores([gameStartedMinsAgo(500)], NOW, null)).toBe(false);
  });

  it('is true on the first call when a game is live', () => {
    expect(shouldFetchScores([gameStartedMinsAgo(60)], NOW, null)).toBe(true);
  });

  it('throttles by the live interval (90m)', () => {
    expect(shouldFetchScores([gameStartedMinsAgo(60)], NOW, minsAgo(40))).toBe(false);
    expect(shouldFetchScores([gameStartedMinsAgo(60)], NOW, minsAgo(100))).toBe(true);
  });

  it('throttles by the tighter settle interval (25m)', () => {
    expect(shouldFetchScores([gameStartedMinsAgo(200)], NOW, minsAgo(10))).toBe(false);
    expect(shouldFetchScores([gameStartedMinsAgo(200)], NOW, minsAgo(30))).toBe(true);
  });
});

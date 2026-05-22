/**
 * propPollingPolicy.test.js
 *
 * Verifies the 48h-track / 30h-refresh split and the tiered refresh cadence.
 */

const {
  shouldFetchPropsForGame,
  getPropFetchWindow,
} = require('../../src/jobs/sports/shared/propPollingPolicy');

const NOW = new Date('2026-05-21T12:00:00Z');
// Build a game whose startTime is `hours` from NOW (negative = already started).
const gameAt = (hours, propsLastFetchedAt = null) => ({
  startTime: new Date(NOW.getTime() + hours * 3600000),
  propsLastFetchedAt,
});
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000);

describe('getPropFetchWindow', () => {
  it('loads the full 48h track window (not the 30h refresh window)', () => {
    const { start, end } = getPropFetchWindow(NOW);
    expect((end - NOW) / 3600000).toBe(48);
    expect((NOW - start) / 60000).toBe(180); // tail cutoff = 3h
  });
});

describe('shouldFetchPropsForGame', () => {
  it('does NOT refresh a game beyond the 30h refresh window (tracked only)', () => {
    expect(shouldFetchPropsForGame(gameAt(40), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(31), NOW)).toBe(false);
  });

  it('does NOT poll a game long past the tail window', () => {
    expect(shouldFetchPropsForGame(gameAt(-4), NOW)).toBe(false);
  });

  it('fetches immediately the first time a game enters the refresh window', () => {
    expect(shouldFetchPropsForGame(gameAt(28, null), NOW)).toBe(true);
  });

  it('far tier (12-30h): refreshes every 6h', () => {
    expect(shouldFetchPropsForGame(gameAt(20, minsAgo(120)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(20, minsAgo(370)), NOW)).toBe(true);
  });

  it('near tier (1.5-6h): refreshes every 60m', () => {
    expect(shouldFetchPropsForGame(gameAt(4, minsAgo(40)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(4, minsAgo(70)), NOW)).toBe(true);
  });

  it('hot tier (around kickoff): refreshes every 25m', () => {
    expect(shouldFetchPropsForGame(gameAt(0.2, minsAgo(10)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(0.2, minsAgo(30)), NOW)).toBe(true);
  });

  it('refreshes more often near kickoff than far out (tier ordering)', () => {
    // 45m of elapsed time: enough for the hot tier (25m) but not the far tier (360m)
    const elapsed = minsAgo(45);
    expect(shouldFetchPropsForGame(gameAt(0, elapsed), NOW)).toBe(true);   // hot
    expect(shouldFetchPropsForGame(gameAt(20, elapsed), NOW)).toBe(false); // far
  });
});

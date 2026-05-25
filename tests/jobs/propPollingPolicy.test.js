/**
 * propPollingPolicy.test.js
 *
 * Verifies the 48h-track / 30h-refresh split, the tiered pre-game cadence,
 * and the status-driven 10-minute "live" tier.
 */

const {
  shouldFetchPropsForGame,
  getPropFetchWindow,
} = require('../../src/jobs/sports/shared/propPollingPolicy');

const NOW = new Date('2026-05-21T12:00:00Z');
// Game `hours` from NOW (negative = already started); status defaults to scheduled.
const gameAt = (hours, propsLastFetchedAt = null, status = 'scheduled') => ({
  startTime: new Date(NOW.getTime() + hours * 3600000),
  propsLastFetchedAt,
  status,
});
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000);

describe('getPropFetchWindow', () => {
  it('loads 48h ahead and reaches back to cover in-progress live games', () => {
    const { start, end } = getPropFetchWindow(NOW);
    expect((end - NOW) / 3600000).toBe(48);
    expect((NOW - start) / 3600000).toBe(6); // live poll window
  });
});

describe('shouldFetchPropsForGame — scheduled tiers', () => {
  it('does NOT refresh a scheduled game beyond the 30h refresh window', () => {
    expect(shouldFetchPropsForGame(gameAt(40), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(31), NOW)).toBe(false);
  });

  it('fetches immediately the first time a game enters the refresh window', () => {
    expect(shouldFetchPropsForGame(gameAt(28, null), NOW)).toBe(true);
  });

  it('far tier (12-30h): every 6h', () => {
    expect(shouldFetchPropsForGame(gameAt(20, minsAgo(120)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(20, minsAgo(370)), NOW)).toBe(true);
  });

  it('mid tier (6-12h): every 3h', () => {
    expect(shouldFetchPropsForGame(gameAt(9, minsAgo(120)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(9, minsAgo(190)), NOW)).toBe(true);
  });

  it('near tier (1-6h): every 60m', () => {
    expect(shouldFetchPropsForGame(gameAt(4, minsAgo(40)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(4, minsAgo(70)), NOW)).toBe(true);
  });

  it('hot tier (final hour before kickoff): every 10m', () => {
    expect(shouldFetchPropsForGame(gameAt(0.5, minsAgo(7)), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(0.5, minsAgo(12)), NOW)).toBe(true);
  });
});

describe('shouldFetchPropsForGame — live tier (status-driven)', () => {
  it('refreshes a LIVE game every ~10m regardless of how long ago it started', () => {
    expect(shouldFetchPropsForGame(gameAt(-2, minsAgo(6), 'live'), NOW)).toBe(false);
    expect(shouldFetchPropsForGame(gameAt(-2, minsAgo(12), 'live'), NOW)).toBe(true);
  });

  it('treats a just-started game still flagged scheduled as hot (10m)', () => {
    // start passed ~15m ago, postGameSync has not flipped it to LIVE yet
    expect(shouldFetchPropsForGame(gameAt(-0.25, minsAgo(12), 'scheduled'), NOW)).toBe(true);
  });

  it('stops polling a game long past the live window', () => {
    expect(shouldFetchPropsForGame(gameAt(-7, minsAgo(999), 'live'), NOW)).toBe(false);
  });
});

describe('shouldFetchPropsForGame — engagement filter', () => {
  it('cold game in the hot window uses the sparse 60m cadence, not 10m', () => {
    const g = gameAt(0.5, minsAgo(20));
    expect(shouldFetchPropsForGame(g, NOW, { engaged: false })).toBe(false); // 20m < 60m
    expect(shouldFetchPropsForGame(g, NOW, { engaged: true })).toBe(true);   // 20m >= 10m
  });

  it('cold LIVE game uses the sparse 60m cadence, not 10m', () => {
    const g = gameAt(-1, minsAgo(20), 'live');
    expect(shouldFetchPropsForGame(g, NOW, { engaged: false })).toBe(false);
    expect(shouldFetchPropsForGame(g, NOW, { engaged: true })).toBe(true);
  });

  it('cold game skips the far tier entirely (12-30h out)', () => {
    const g = gameAt(20, minsAgo(999));
    expect(shouldFetchPropsForGame(g, NOW, { engaged: false })).toBe(false);
    expect(shouldFetchPropsForGame(g, NOW, { engaged: true })).toBe(true);
  });

  it('near/mid tiers are identical for cold and engaged games', () => {
    const near = gameAt(4, minsAgo(70));
    expect(shouldFetchPropsForGame(near, NOW, { engaged: false })).toBe(true);
    expect(shouldFetchPropsForGame(near, NOW, { engaged: true })).toBe(true);
  });

  it('defaults to engaged when no option is passed', () => {
    expect(shouldFetchPropsForGame(gameAt(0.5, minsAgo(12)), NOW)).toBe(true);
  });
});

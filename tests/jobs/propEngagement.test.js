/**
 * propEngagement.test.js
 *
 * Engagement is read from two user-action markers on the Game; it must NOT be
 * inferred from Insight documents (the performance pipeline auto-generates
 * insights for games no user touched).
 */

const {
  isGameEngaged,
  getEngagedEventIds,
} = require('../../src/jobs/sports/shared/propEngagement');

const NOW = new Date('2026-05-21T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);

describe('isGameEngaged', () => {
  it('is engaged when a real user unlocked an insight (sticky, never decays)', () => {
    // propsUserUnlockedAt counts even if it was set days ago.
    expect(isGameEngaged({ propsUserUnlockedAt: hoursAgo(72) }, NOW)).toBe(true);
  });

  it('is engaged when props were viewed within the 24h TTL', () => {
    expect(isGameEngaged({ propsLastViewedAt: hoursAgo(5) }, NOW)).toBe(true);
  });

  it('is cold when the only view is older than the TTL', () => {
    expect(isGameEngaged({ propsLastViewedAt: hoursAgo(30) }, NOW)).toBe(false);
  });

  it('is cold when there is no view and no user unlock', () => {
    expect(isGameEngaged({}, NOW)).toBe(false);
    expect(isGameEngaged(null, NOW)).toBe(false);
  });

  it('does NOT consider insight existence — only the Game markers matter', () => {
    // A game the performance pipeline auto-generated insights for, but which
    // no user ever viewed or unlocked, must stay cold.
    expect(isGameEngaged({ hasProps: true, status: 'scheduled' }, NOW)).toBe(false);
  });
});

describe('getEngagedEventIds', () => {
  it('returns only the engaged event ids', async () => {
    const games = [
      { oddsEventId: 'e_unlocked', propsUserUnlockedAt: hoursAgo(50) },
      { oddsEventId: 'e_viewed',   propsLastViewedAt: hoursAgo(2) },
      { oddsEventId: 'e_stale',    propsLastViewedAt: hoursAgo(40) },
      { oddsEventId: 'e_cold' },
    ];
    const engaged = await getEngagedEventIds(games, NOW);
    expect(engaged.has('e_unlocked')).toBe(true);
    expect(engaged.has('e_viewed')).toBe(true);
    expect(engaged.has('e_stale')).toBe(false);
    expect(engaged.has('e_cold')).toBe(false);
    expect(engaged.size).toBe(2);
  });
});

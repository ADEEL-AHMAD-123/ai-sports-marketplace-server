/**
 * nflSeason.test.js — NFL season-year resolution
 *
 * The NFL season is identified by its starting year: Jan–Jul belongs to the
 * previous calendar year's season, Aug–Dec to the current one.
 */

const { nflSeasonYear } = require('../../../src/services/sports/nfl/nflSeason');

describe('nflSeasonYear', () => {
  it('maps January playoff games to the previous calendar year', () => {
    expect(nflSeasonYear('2026-01-15T18:00:00Z')).toBe(2025);
  });

  it('maps the February Super Bowl to the previous calendar year', () => {
    expect(nflSeasonYear('2026-02-08T23:30:00Z')).toBe(2025);
  });

  it('maps July (offseason) to the previous calendar year', () => {
    expect(nflSeasonYear('2025-07-31T12:00:00Z')).toBe(2024);
  });

  it('maps August onward to the current calendar year (preseason opens)', () => {
    expect(nflSeasonYear('2025-08-01T12:00:00Z')).toBe(2025);
  });

  it('maps the regular season (Sep–Dec) to the current calendar year', () => {
    expect(nflSeasonYear('2025-09-07T17:00:00Z')).toBe(2025);
    expect(nflSeasonYear('2025-12-25T17:00:00Z')).toBe(2025);
  });

  it('accepts Date objects as well as strings', () => {
    expect(nflSeasonYear(new Date('2026-01-15T18:00:00Z'))).toBe(2025);
  });

  it('falls back to "now" for invalid or missing input', () => {
    const expected = nflSeasonYear(new Date());
    expect(nflSeasonYear('not-a-date')).toBe(expected);
    expect(nflSeasonYear()).toBe(expected);
    expect(nflSeasonYear(undefined)).toBe(expected);
  });
});

/**
 * nflSeason.js — NFL season-year resolution
 *
 * The NFL season is identified by its STARTING year: the 2025 season opens
 * in September 2025 and runs through the Super Bowl in early February 2026.
 * Any date from January through July therefore belongs to the PREVIOUS
 * year's season.
 *
 * API-Sports (injuries, player statistics) keys season-scoped data by this
 * starting year, so every season-scoped request must use it — using the raw
 * calendar year breaks every January/February game (the entire playoffs).
 */

/**
 * Resolve the NFL season's starting year for a given date.
 *
 * @param {Date|string|number} [date] — defaults to now; invalid input falls back to now.
 * @returns {number} the NFL season's starting year
 */
function nflSeasonYear(date = new Date()) {
  let d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) d = new Date();

  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1 = Jan ... 12 = Dec

  // August onward belongs to the upcoming season (preseason opens early Aug);
  // January–July belongs to the season that started the previous calendar year.
  return month >= 8 ? year : year - 1;
}

module.exports = { nflSeasonYear };

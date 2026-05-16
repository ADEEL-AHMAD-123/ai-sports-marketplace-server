/**
 * adapterRegistry.js
 *
 * TO ADD A NEW SPORT (e.g. NHL):
 *  1. Create /services/sports/nhl/NHLAdapter.js  (copy MLBAdapter, change sport key + fields)
 *  2. Create /services/sports/nhl/NHLFormulas.js (copy MLBFormulas, adapt stat fields)
 *  3. Add NHL team IDs to /services/shared/teamMaps.js
 *  4. Import and register NHLAdapter below
 *  5. Add 'nhl' to ACTIVE_SPORTS in constants.js
 *  Done — all services pick it up automatically
 */

const { SPORTS } = require('../../config/constants');
const logger     = require('../../config/logger');

const NBAAdapter = require('../sports/nba/NBAAdapter');
const MLBAdapter = require('../sports/mlb/MLBAdapter');
const NFLAdapter = require('../sports/nfl/NFLAdapter');
const NHLAdapter = require('../sports/nhl/NHLAdapter');
const SoccerAdapter = require('../sports/soccer/SoccerAdapter');

class StubAdapter {
  constructor(sport) { this.sport = sport; }
  _err() { throw new Error(`[${this.sport.toUpperCase()}] Adapter not yet implemented`); }
  fetchSchedule()    { this._err(); }
  fetchProps()       { this._err(); }
  fetchPlayerStats() { this._err(); }
  fetchCurrentLine() { this._err(); }
  applyFormulas()    { return {}; }
  buildPrompt()      { return ''; }
  getRequiredStats() { return []; }
}

const registry = {
  [SPORTS.NBA]:    new NBAAdapter(),
  [SPORTS.MLB]:    new MLBAdapter(),
  [SPORTS.NFL]:    new NFLAdapter(),
  [SPORTS.NHL]:    new NHLAdapter(),
  [SPORTS.SOCCER]: new SoccerAdapter(),
};

const getAdapter = (sport) => {
  const adapter = registry[sport];
  if (!adapter) throw new Error(`Unknown sport: "${sport}"`);
  return adapter;
};

const getActiveSports = () =>
  Object.entries(registry)
    .filter(([, a]) => !(a instanceof StubAdapter))
    .map(([s]) => s);

module.exports = { getAdapter, getActiveSports };
/**
 * adapterRegistry.js — Central registry for all sport adapters
 *
 * This is the single entry point for getting a sport adapter.
 * InsightService, cron jobs, and controllers call getAdapter(sport)
 * and never import adapters directly.
 *
 * TO ADD A NEW SPORT:
 *  1. Create /adapters/[sport]/[Sport]Adapter.js extending BaseAdapter
 *  2. Import and register it here with its SPORTS constant key
 *  3. That's it — all services pick it up automatically
 *
 * Currently active (Phase 1):
 *  ✅ NBA — fully implemented
 *
 * Planned (APIs TBD — stubs registered to fail gracefully):
 *  🔜 NFL, MLB, NHL, Soccer
 */

const { SPORTS } = require('../../config/constants');
const logger = require('../../config/logger');

// ─── Import active adapters ────────────────────────────────────────────────────
const NBAAdapter = require('./nba/NBAAdapter');

// ─── Placeholder for future sports ────────────────────────────────────────────
// These will be replaced with real adapters as each sport is implemented.
// Registering stubs here prevents the registry from crashing on lookup.
class StubAdapter {
  constructor(sport) {
    this.sport = sport;
  }
  _notImplemented() {
    throw new Error(
      `[${this.sport.toUpperCase()}] Adapter not yet implemented. ` +
      `This sport is planned for a future phase. ` +
      `Add the adapter in /services/adapters/${this.sport}/ when ready.`
    );
  }
  fetchSchedule()             { this._notImplemented(); }
  fetchProps()                { this._notImplemented(); }
  fetchPlayerStats()          { this._notImplemented(); }
  fetchCurrentLine()          { this._notImplemented(); }
  applyFormulas()             { this._notImplemented(); }
  buildPrompt()               { this._notImplemented(); }
  getRequiredStats()          { return []; }
}

// ─── Registry map: sport key → adapter instance ───────────────────────────────
// Adapters are singletons (instantiated once, reused)
const registry = {
  [SPORTS.NBA]:    new NBAAdapter(),
  [SPORTS.NFL]:    new StubAdapter(SPORTS.NFL),
  [SPORTS.MLB]:    new StubAdapter(SPORTS.MLB),
  [SPORTS.NHL]:    new StubAdapter(SPORTS.NHL),
  [SPORTS.SOCCER]: new StubAdapter(SPORTS.SOCCER),
};

/**
 * Get the adapter for a given sport.
 *
 * @param {string} sport - One of the SPORTS constant values
 * @returns {BaseAdapter} The sport-specific adapter instance
 * @throws {Error} If sport key is not recognized
 */
const getAdapter = (sport) => {
  const adapter = registry[sport];

  if (!adapter) {
    logger.error(`❌ No adapter found for sport: "${sport}"`);
    throw new Error(
      `Unknown sport: "${sport}". Valid options: ${Object.keys(registry).join(', ')}`
    );
  }

  logger.debug(`🔌 Adapter loaded for sport: ${sport}`);
  return adapter;
};

/**
 * List all sports that have fully implemented (non-stub) adapters.
 *
 * @returns {string[]} Array of active sport keys
 */
const getActiveSports = () => {
  return Object.entries(registry)
    .filter(([, adapter]) => !(adapter instanceof StubAdapter))
    .map(([sport]) => sport);
};

module.exports = { getAdapter, getActiveSports };
/**
 * NHLInjuryService.js — NHL injury status
 *
 * NOTE: The official NHL Stats API does not provide a public injury endpoint.
 * API-Sports Hockey also does not provide reliable NHL injury data.
 *
 * Current approach: return empty map (no injury filtering for NHL).
 * Future: integrate a third-party injury feed (FantasyPros, RotowireAPI)
 *         when available.
 *
 * PropWatcher will not mark NHL players as unavailable due to injury
 * until a reliable data source is integrated.
 */

const logger = require('../../../config/logger');

async function getInjuryMap(gameCtx = {}) {
  // No reliable NHL injury data source available
  return new Map();
}

async function getPlayerInjury(playerName, gameCtx = {}) {
  return null;
}

async function getInjuryPromptContext(playerName, gameCtx = {}) {
  return null;
}

module.exports = { getInjuryMap, getPlayerInjury, getInjuryPromptContext };


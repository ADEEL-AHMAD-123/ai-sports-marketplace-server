/**
 * NBAOutcomeGrader.js — NBA-specific stat extraction and player lookup
 *
 * Knows how to:
 *   1. Look up the API-Sports player ID for a given insight
 *      (tries PlayerProp first, falls back to PlayerCache — fixes the
 *       "all NBA unresolved" bug caused by prop deletion at 6h)
 *   2. Fetch the player's game log via NBAAdapter
 *   3. Extract the correct stat value from a game log row
 *
 * TO TEST INDEPENDENTLY:
 *   const grader = require('./NBAOutcomeGrader');
 *   const stats  = await grader.fetchStatsForInsight(insight, statsCache);
 *   const actual = grader.extractStat(stats[0], 'points');
 */

const PlayerProp  = require('../../../models/PlayerProp.model');
const { PlayerCache } = require('../../../utils/playerResolver');
const { getAdapter }  = require('../../shared/adapterRegistry');
const logger          = require('../../../config/logger');

// ─── Stat extraction ──────────────────────────────────────────────────────────
// API-Sports NBA v2 game log — all FLAT fields (no nesting):
//   points, totReb, assists, tpm (3PM), fgm, fga, min

const NBA_STAT_MAP = {
  points:         row => num(row.points),
  rebounds:       row => num(row.totReb)  || num(row.rebounds) || num(row.reb),
  assists:        row => num(row.assists) || num(row.ast),
  threes:         row => num(row.tpm)     || num(row.threes)   || num(row.fg3m),
  points_assists: row => {
    const p = num(row.points);
    const a = num(row.assists) || num(row.ast);
    return (Number.isFinite(p) && Number.isFinite(a)) ? p + a : null;
  },
};

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Extract the correct stat value from one game log row.
 * Returns null if the stat type is unknown or the field is missing.
 */
function extractStat(row, statType) {
  const fn = NBA_STAT_MAP[statType];
  if (!fn) return null;
  return fn(row);
}

// ─── Player ID lookup ─────────────────────────────────────────────────────────

/**
 * Resolve the API-Sports player ID for an NBA insight.
 * 1. Check PlayerProp (may be gone after 6h deletion)
 * 2. Fall back to PlayerCache (permanent, keyed by normalized name)
 */
async function resolvePlayerId(insight) {
  // Try PlayerProp first — it has the per-event-per-statType specific ID
  const prop = await PlayerProp.findOne({
    oddsEventId: insight.eventId,
    playerName:  insight.playerName,
    statType:    insight.statType,
    sport:       'nba',
  }).select('apiSportsPlayerId').lean();

  if (prop?.apiSportsPlayerId) return prop.apiSportsPlayerId;

  // Fallback: PlayerCache is never deleted by game lifecycle
  const normName = (insight.playerName || '')
    .toLowerCase().replace(/['.]/g, '').trim();

  const cached = await PlayerCache.findOne({
    sport:       'nba',
    oddsApiName: normName,
  }).select('apiSportsId').lean();

  if (cached?.apiSportsId) {
    logger.debug('[NBAOutcomeGrader] PlayerCache fallback used', {
      playerName: insight.playerName,
      apiSportsId: cached.apiSportsId,
    });
    return cached.apiSportsId;
  }

  return null;
}

// ─── Stats fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch the game log for one NBA insight player.
 * Uses statsCache (Map) to avoid repeat calls across insights in the same batch.
 *
 * @param {Object} insight   — lean Insight document
 * @param {Map}    statsCache — shared across all insights in one grading run
 * @returns {Promise<Array>} array of game log rows
 */
async function fetchStatsForInsight(insight, statsCache) {
  const playerId = await resolvePlayerId(insight);

  if (!playerId) {
    logger.warn('[NBAOutcomeGrader] No player ID found', {
      playerName: insight.playerName,
      statType:   insight.statType,
    });
    return [];
  }

  const cacheKey = `nba::${playerId}`;
  if (!statsCache.has(cacheKey)) {
    const adapter = getAdapter('nba');
    const stats   = await adapter.fetchPlayerStats({ playerId }) || [];
    statsCache.set(cacheKey, stats);
  }

  return statsCache.get(cacheKey);
}

module.exports = { extractStat, fetchStatsForInsight, resolvePlayerId };


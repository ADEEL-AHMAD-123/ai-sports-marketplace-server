/**
 * NHLOutcomeGrader.js — NHL-specific stat extraction and stats fetch
 *
 * Pulls home/away team names from the persisted PlayerProp/Game so the
 * underlying NHL Stats API roster lookup succeeds. Cache key includes the
 * team context to avoid collisions between players who share a surname.
 *
 * TO TEST INDEPENDENTLY:
 *   const grader = require('./NHLOutcomeGrader');
 *   const stats  = await grader.fetchStatsForInsight(insight, statsCache);
 *   const actual = grader.extractStat(stats[0], 'shots_on_goal');
 */

const { getAdapter } = require('../../shared/adapterRegistry');
const NHLStatsClient = require('./NHLStatsClient');
const logger         = require('../../../config/logger');

const NHL_STAT_MAP = {
  goals:         row => num(row.goals),
  assists:       row => num(row.assists),
  shots_on_goal: row => num(row.shots) || num(row.shotsOnGoal) || num(row.sog),
  points:        row => {
    const g = num(row.goals);
    const a = num(row.assists);
    return (g !== null && a !== null) ? g + a : null;
  },
};

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function extractStat(row, statType) {
  const fn = NHL_STAT_MAP[statType];
  if (!fn) return null;
  return fn(row);
}

/**
 * Fetch player stats with team context. Looks up the prop or falls back to
 * the Game collection so the NHL roster resolver has both home/away names.
 *
 * @param {Object} insight  — { sport, eventId, playerName, statType }
 * @param {Map}    statsCache — shared cache across the grading batch
 * @returns {Promise<Array>}
 */
async function fetchStatsForInsight(insight, statsCache) {
  // Lazy-require to avoid cycles when models load adapters
  const PlayerProp = require('../../../models/PlayerProp.model');
  const { Game }   = require('../../../models/Game.model');

  let homeTeamName = null;
  let awayTeamName = null;

  // First try the prop (denormalized fields)
  const prop = await PlayerProp.findOne(
    {
      sport:       'nhl',
      oddsEventId: insight.eventId,
      playerName:  insight.playerName,
      statType:    insight.statType,
    },
    { homeTeamName: 1, awayTeamName: 1 }
  ).lean();

  if (prop) {
    homeTeamName = prop.homeTeamName;
    awayTeamName = prop.awayTeamName;
  }

  // Fall back to the Game (prop may have been deleted in stale-cleanup)
  if (!homeTeamName || !awayTeamName) {
    const game = await Game.findOne(
      { sport: 'nhl', oddsEventId: insight.eventId },
      { 'homeTeam.name': 1, 'awayTeam.name': 1 }
    ).lean();
    if (game) {
      homeTeamName = homeTeamName || game.homeTeam?.name || null;
      awayTeamName = awayTeamName || game.awayTeam?.name || null;
    }
  }

  const teamsKey = [homeTeamName, awayTeamName]
    .filter(Boolean)
    .map(NHLStatsClient.getTeamAbbrev)
    .filter(Boolean)
    .sort()
    .join('-') || 'noteam';
  const cacheKey = `nhl::${teamsKey}::${NHLStatsClient.normName(insight.playerName)}`;

  if (!statsCache.has(cacheKey)) {
    const adapter = getAdapter('nhl');
    const stats   = await adapter.fetchPlayerStats({
      playerName: insight.playerName,
      homeTeamName,
      awayTeamName,
    }) || [];
    statsCache.set(cacheKey, stats);
    if (!stats.length) {
      logger.debug('[NHLOutcomeGrader] No stats returned', {
        playerName: insight.playerName, eventId: insight.eventId,
        homeTeamName, awayTeamName,
      });
    }
  }
  return statsCache.get(cacheKey);
}

module.exports = { extractStat, fetchStatsForInsight };

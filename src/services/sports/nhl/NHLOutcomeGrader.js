/**
 * NHLOutcomeGrader.js — NHL-specific stat extraction and stats fetch
 *
 * TO TEST INDEPENDENTLY:
 *   const grader = require('./NHLOutcomeGrader');
 *   const stats  = await grader.fetchStatsForInsight(insight, statsCache);
 *   const actual = grader.extractStat(stats[0], 'shots_on_goal');
 */

const { getAdapter } = require('../../shared/adapterRegistry');

// API-Sports Hockey v1 game stat fields
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

async function fetchStatsForInsight(insight, statsCache) {
  const cacheKey = `nhl::${insight.playerName}`;
  if (!statsCache.has(cacheKey)) {
    const adapter = getAdapter('nhl');
    const stats   = await adapter.fetchPlayerStats({ playerName: insight.playerName }) || [];
    statsCache.set(cacheKey, stats);
  }
  return statsCache.get(cacheKey);
}

module.exports = { extractStat, fetchStatsForInsight };


/**
 * MLBOutcomeGrader.js — MLB-specific stat extraction and stats fetch
 *
 * TO TEST INDEPENDENTLY:
 *   const grader = require('./MLBOutcomeGrader');
 *   const stats  = await grader.fetchStatsForInsight(insight, statsCache);
 *   const actual = grader.extractStat(stats[0], 'hits');
 */

const { getAdapter } = require('../../shared/adapterRegistry');
const logger         = require('../../../config/logger');

// MLB Stats API (official) hitting + pitching field names
const MLB_STAT_MAP = {
  hits:               row => num(row.hits)       || num(row.h),
  total_bases:        row => num(row.totalBases)  || num(row.tb),
  runs:               row => num(row.runs)        || num(row.r),
  rbis:               row => num(row.rbi)         || num(row.rbis),
  pitcher_strikeouts: row => num(row.strikeOuts)  || num(row.strikeouts) || num(row.so) || num(row.k),
};

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function extractStat(row, statType) {
  const fn = MLB_STAT_MAP[statType];
  if (!fn) return null;
  return fn(row);
}

async function fetchStatsForInsight(insight, statsCache) {
  const isPitcher = insight.statType === 'pitcher_strikeouts';
  const cacheKey  = `mlb::${insight.playerName}::${isPitcher ? 'pitcher' : 'batter'}`;

  if (!statsCache.has(cacheKey)) {
    const adapter = getAdapter('mlb');
    const stats   = await adapter.fetchPlayerStats({
      playerName: insight.playerName,
      isPitcher,
    }) || [];
    statsCache.set(cacheKey, stats);
  }

  return statsCache.get(cacheKey);
}

module.exports = { extractStat, fetchStatsForInsight };


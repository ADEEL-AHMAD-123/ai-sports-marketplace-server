/**
 * MLBInjuryService.js — MLB injury data (Official MLB Stats API)
 *
 * TO TEST INDEPENDENTLY:
 *   const svc = require('./MLBInjuryService');
 *   const map = await svc.getInjuryMap({ homeTeamName: 'Philadelphia Phillies', awayTeamName: 'Cleveland Guardians' });
 */

const mlbStatsClient = require('../../shared/MLBStatsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const CACHE_TTL = 30 * 60;

const MLB_SEVERITY_MAP = {
  '60-day':      { severity: 'critical', status: 'Out' },
  '10-day':      { severity: 'critical', status: 'Out' },
  '7-day':       { severity: 'critical', status: 'Out' },
  'bereavement': { severity: 'minor',    status: 'Questionable' },
  'paternity':   { severity: 'minor',    status: 'Questionable' },
  'day-to-day':  { severity: 'minor',    status: 'Questionable' },
  'suspended':   { severity: 'critical', status: 'Out' },
};

const normKey = (name = '') =>
  String(name).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

function parseRosterEntry(entry) {
  const description = (entry?.status?.description || '').toLowerCase();
  if (!description || description === 'active') return null;
  for (const [kw, tier] of Object.entries(MLB_SEVERITY_MAP)) {
    if (description.includes(kw)) return { ...tier, reason: entry.status.description };
  }
  return { status: 'Out', severity: 'major', reason: entry.status.description };
}

async function _getTeamIL(teamName) {
  const cacheKey = `injury:mlb:team:${normKey(teamName)}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const teamId = await mlbStatsClient.getTeamIdByName(teamName);
  if (!teamId) return [];

  const roster = await mlbStatsClient.getInjuredListForTeam(teamId);
  await cacheSet(cacheKey, roster, CACHE_TTL);
  return roster;
}

async function getInjuryMap(gameCtx = {}) {
  const result = new Map();
  const teams  = [gameCtx.homeTeamName, gameCtx.awayTeamName].filter(Boolean);

  for (const teamName of teams) {
    try {
      const roster = await _getTeamIL(teamName);
      for (const entry of roster) {
        const injury = parseRosterEntry(entry);
        if (!injury) continue;
        const key = normKey(entry?.person?.fullName || '');
        if (key) result.set(key, injury);
      }
    } catch (err) {
      logger.warn('[MLBInjuryService] team IL fetch failed', { teamName, error: err.message });
    }
  }

  return result;
}

async function getPlayerInjury(playerName, gameCtx) {
  const map = await getInjuryMap(gameCtx);
  return map.get(normKey(playerName)) || null;
}

async function getInjuryPromptContext(playerName, gameCtx) {
  const injury = await getPlayerInjury(playerName, gameCtx);
  if (!injury) return null;
  if (injury.status === 'Out')      return `Player OUT — ${injury.reason || 'injury'}`;
  if (injury.status === 'Doubtful') return 'Player doubtful, may not play';
  return `Player day-to-day, minor injury`;
}

module.exports = { getInjuryMap, getPlayerInjury, getInjuryPromptContext };


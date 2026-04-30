/**
 * NBAInjuryService.js — NBA injury data (API-Sports NBA v2)
 *
 * TO TEST INDEPENDENTLY:
 *   const svc = require('./NBAInjuryService');
 *   const map = await svc.getInjuryMap({ homeTeamName: 'Oklahoma City Thunder', awayTeamName: 'Houston Rockets' });
 */

const ApiSportsClient = require('../../shared/ApiSportsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const CACHE_TTL  = 30 * 60; // 30 min
const LEAGUE_ID  = 12;

const NBA_STATUS_MAP = {
  'out':          { severity: 'critical', status: 'Out' },
  'inactive':     { severity: 'critical', status: 'Out' },
  'doubtful':     { severity: 'major',    status: 'Doubtful' },
  'questionable': { severity: 'minor',    status: 'Questionable' },
  'probable':     { severity: 'minor',    status: 'Questionable' },
};

const normKey = (name = '') =>
  String(name).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

let _client = null;
const client = () => { if (!_client) _client = new ApiSportsClient('nba'); return _client; };

/**
 * @returns {Promise<Map<string, {status,severity,reason}>>}
 */
async function getInjuryMap(gameCtx = {}) {
  const cacheKey = `injury:nba:game:${gameCtx.oddsEventId || normKey([gameCtx.homeTeamName, gameCtx.awayTeamName].join('_'))}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  const result = new Map();

  try {
    const season  = (() => { const now = new Date(); const yr = now.getFullYear(); return (now.getMonth()+1)>=10 ? yr : yr-1; })();
    const entries = await client().get('/injuries', { league: LEAGUE_ID, season }) || [];

    for (const entry of entries) {
      const statusRaw = (entry?.player?.status || entry?.status || '').toLowerCase().trim();
      const tier      = NBA_STATUS_MAP[statusRaw];
      if (!tier) continue;
      const name = entry?.player?.name || entry?.player?.fullName || '';
      const key  = normKey(name);
      if (key) result.set(key, { ...tier, reason: entry?.comment || entry?.type || null });
    }

    await cacheSet(cacheKey, Object.fromEntries(result), CACHE_TTL);
  } catch (err) {
    logger.warn('[NBAInjuryService] fetch failed', { error: err.message });
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


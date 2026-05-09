const ApiSportsClient = require('../../shared/ApiSportsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const CACHE_TTL = 30 * 60;
const MLS_LEAGUE_ID = 253;
const FIXTURE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const STATUS_MAP = {
  'missing fixture': { status: 'Out', severity: 'critical' },
  'questionable': { status: 'Questionable', severity: 'minor' },
};

let _client = null;
const client = () => {
  if (!_client) _client = new ApiSportsClient('soccer');
  return _client;
};

const normKey = (name = '') => String(name)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[.'\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const getSeasonYear = (gameCtx = {}) => {
  const baseDate = gameCtx.startTime ? new Date(gameCtx.startTime) : new Date();
  const year = baseDate.getUTCFullYear();
  if (Number(gameCtx.leagueId) === MLS_LEAGUE_ID) return year;
  return (baseDate.getUTCMonth() + 1) >= 8 ? year : year - 1;
};

async function _fetchLeagueInjuries(leagueId, seasonYear) {
  if (!leagueId || !seasonYear) return [];

  const cacheKey = `injury:soccer:league:${leagueId}:season:${seasonYear}`;
  const cached = await cacheGet(cacheKey);
  if (Array.isArray(cached)) return cached;

  try {
    const entries = await client().get('injuries', { league: leagueId, season: seasonYear }) || [];
    await cacheSet(cacheKey, entries, CACHE_TTL);
    return entries;
  } catch (err) {
    logger.warn('[SoccerInjuryService] fetch failed', { leagueId, seasonYear, error: err.message });
    return [];
  }
}

async function getInjuryMap(gameCtx = {}) {
  const leagueId = Number(gameCtx.leagueId) || null;
  if (!leagueId) return new Map();

  const seasonYear = getSeasonYear(gameCtx);
  const entries = await _fetchLeagueInjuries(leagueId, seasonYear);
  const homeTeamId = Number(gameCtx.homeTeamApiSportsId) || null;
  const awayTeamId = Number(gameCtx.awayTeamApiSportsId) || null;
  const homeTeamName = normKey(gameCtx.homeTeamName || '');
  const awayTeamName = normKey(gameCtx.awayTeamName || '');
  const gameTs = gameCtx.startTime ? new Date(gameCtx.startTime).getTime() : null;

  const result = new Map();
  const metaByPlayer = new Map();

  for (const entry of entries) {
    const player = entry?.player || {};
    const team = entry?.team || {};
    const teamId = Number(team.id) || null;
    const teamName = normKey(team.name || '');

    const matchesTeam = (homeTeamId && teamId === homeTeamId)
      || (awayTeamId && teamId === awayTeamId)
      || (!!teamName && (teamName === homeTeamName || teamName === awayTeamName));

    if (!matchesTeam) continue;

    const fixtureTs = Number(entry?.fixture?.timestamp) ? Number(entry.fixture.timestamp) * 1000 : null;
    if (gameTs && fixtureTs && Math.abs(fixtureTs - gameTs) > FIXTURE_WINDOW_MS) continue;

    const nameKey = normKey(player.name || '');
    if (!nameKey) continue;

    const typeKey = normKey(player.type || '');
    const statusInfo = STATUS_MAP[typeKey] || STATUS_MAP['missing fixture'];

    const candidate = {
      status: statusInfo.status,
      severity: statusInfo.severity,
      reason: player.reason || player.type || 'Injury report',
    };

    const prevMeta = metaByPlayer.get(nameKey);
    if (gameTs && fixtureTs) {
      const distance = Math.abs(fixtureTs - gameTs);
      if (!prevMeta || distance < prevMeta.distance) {
        metaByPlayer.set(nameKey, { distance });
        result.set(nameKey, candidate);
      }
      continue;
    }

    if (!prevMeta) {
      metaByPlayer.set(nameKey, { distance: Number.MAX_SAFE_INTEGER });
      result.set(nameKey, candidate);
    }
  }

  return result;
}

async function getPlayerInjury(playerName, gameCtx = {}) {
  const map = await getInjuryMap(gameCtx);
  return map.get(normKey(playerName)) || null;
}

async function getInjuryPromptContext(playerName, gameCtx = {}) {
  const injury = await getPlayerInjury(playerName, gameCtx);
  if (!injury) return null;
  const reason = injury.reason ? ` — ${injury.reason}` : '';
  if (injury.status === 'Out') return `Player OUT${reason}`;
  return `Questionable${reason}`;
}

module.exports = {
  getInjuryMap,
  getPlayerInjury,
  getInjuryPromptContext,
};
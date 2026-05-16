/**
 * NFLInjuryService.js — NFL injury data (API-Sports American Football)
 *
 * Source endpoint:
 *   GET /injuries?league=1&season=YYYY
 *
 * Notes:
 * - API payload shapes vary by provider/tier, so parsing is intentionally
 *   defensive and supports multiple field aliases.
 * - Cache strategy mirrors other sports: season-level fetch cache +
 *   game-level filtered map cache.
 */

const ApiSportsClient = require('../../shared/ApiSportsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const CACHE_TTL = 30 * 60; // 30 min
const LEAGUE_ID = 1;

const STATUS_MAP = {
  out: { severity: 'critical', status: 'Out' },
  inactive: { severity: 'critical', status: 'Out' },
  suspended: { severity: 'critical', status: 'Out' },
  suspension: { severity: 'critical', status: 'Out' },
  'injured reserve': { severity: 'critical', status: 'Out' },
  ir: { severity: 'critical', status: 'Out' },
  doubtful: { severity: 'major', status: 'Doubtful' },
  questionable: { severity: 'minor', status: 'Questionable' },
  probable: { severity: 'minor', status: 'Questionable' },
  'day to day': { severity: 'minor', status: 'Questionable' },
};

let _client = null;
const client = () => {
  if (!_client) _client = new ApiSportsClient('nfl');
  return _client;
};

const normKey = (name = '') =>
  String(name).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

const _currentSeason = () => {
  const now = new Date();
  return now.getFullYear();
};

const _pick = (obj, paths = []) => {
  for (const path of paths) {
    const val = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
};

const _toStatus = (raw = '') => {
  const key = normKey(raw);
  if (!key) return null;
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  if (key.includes('injured reserve') || key === 'ir') return STATUS_MAP['injured reserve'];
  if (key.includes('susp')) return STATUS_MAP.suspended;
  if (key.includes('question')) return STATUS_MAP.questionable;
  if (key.includes('doubt')) return STATUS_MAP.doubtful;
  if (key.includes('probable')) return STATUS_MAP.probable;
  if (key.includes('out') || key.includes('inactive')) return STATUS_MAP.out;
  return null;
};

async function _fetchLeagueInjuries(season) {
  const cacheKey = `injury:nfl:league:${LEAGUE_ID}:season:${season}`;
  const cached = await cacheGet(cacheKey);
  if (Array.isArray(cached)) return cached;

  try {
    const rows = await client().get('injuries', { league: LEAGUE_ID, season }) || [];
    await cacheSet(cacheKey, rows, CACHE_TTL);
    return rows;
  } catch (err) {
    logger.warn('[NFLInjuryService] fetch failed', { season, error: err.message });
    return [];
  }
}

/**
 * @returns {Promise<Map<string, {status,severity,reason}>>}
 */
async function getInjuryMap(gameCtx = {}) {
  const season = _currentSeason();
  const cacheKey = `injury:nfl:game:${gameCtx.oddsEventId || normKey([gameCtx.homeTeamName, gameCtx.awayTeamName].join('_'))}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  const homeTeam = normKey(gameCtx.homeTeamName || '');
  const awayTeam = normKey(gameCtx.awayTeamName || '');
  const entries = await _fetchLeagueInjuries(season);

  const result = new Map();

  for (const row of entries) {
    const playerName = _pick(row, [
      'player.name',
      'player.fullName',
      'athlete.name',
      'athlete.fullName',
      'name',
    ]);
    const playerKey = normKey(playerName || '');
    if (!playerKey) continue;

    const teamName = normKey(_pick(row, ['team.name', 'team.teamName', 'franchise.name']) || '');
    if (homeTeam || awayTeam) {
      const matchesTeam = (homeTeam && teamName === homeTeam) || (awayTeam && teamName === awayTeam);
      if (!matchesTeam) continue;
    }

    const rawStatus = _pick(row, [
      'player.status',
      'status',
      'designation',
      'injury.status',
      'injury.designation',
      'type',
    ]);
    const statusInfo = _toStatus(rawStatus || '');
    if (!statusInfo) continue;

    const reason = _pick(row, [
      'injury.reason',
      'injury.detail',
      'player.reason',
      'comment',
      'description',
      'type',
    ]);

    result.set(playerKey, {
      ...statusInfo,
      reason: reason || 'Injury report',
    });
  }

  await cacheSet(cacheKey, Object.fromEntries(result), CACHE_TTL);
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
  if (injury.status === 'Doubtful') return `Player doubtful${reason}`;
  return `Player questionable${reason}`;
}

module.exports = {
  getInjuryMap,
  getPlayerInjury,
  getInjuryPromptContext,
};

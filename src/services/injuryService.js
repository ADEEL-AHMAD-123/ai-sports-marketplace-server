/**
 * injuryService.js — Player injury status resolution
 *
 * Sources:
 *  NBA  → API-Sports NBA v2  (/injuries endpoint, cached 30 min)
 *  MLB  → Official MLB Stats API (injured list roster per team, cached 30 min)
 *
 * Exports:
 *  isInjurySportSupported(sport)              → boolean
 *  getPlayerInjuryStatus(name, game, sport)   → { status, severity, reason } | null
 *  getInjuryPromptContext(name, game, sport)   → string (for AI prompt injection)
 *  getInjuryStatusesForGame(gameCtx, sport)   → Map<normalizedName, injury>
 */

const ApiSportsClient = require('./shared/ApiSportsClient');
const mlbStatsClient  = require('./shared/MLBStatsClient');
const { cacheGet, cacheSet } = require('../config/redis');
const logger = require('../config/logger');

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_SPORTS = new Set(['nba', 'mlb']); // nhl: no injury API yet

const INJURY_SERVICES = {
  nba: true,
  mlb: true,
  nhl: null,
};

const INJURY_CACHE_TTL = 30 * 60; // 30 min

// API-Sports league IDs
const API_SPORTS_LEAGUES = { nba: 12 };

// Severity tiers (MLB IL descriptions → tier)
const MLB_SEVERITY_MAP = {
  '60-day':      { severity: 'critical', status: 'Out' },
  '10-day':      { severity: 'critical', status: 'Out' },
  '7-day':       { severity: 'critical', status: 'Out' },
  'bereavement': { severity: 'minor',    status: 'Questionable' },
  'paternity':   { severity: 'minor',    status: 'Questionable' },
  'day-to-day':  { severity: 'minor',    status: 'Questionable' },
  'suspended':   { severity: 'critical', status: 'Out' },
};

// API-Sports injury status → our tier
const NBA_STATUS_MAP = {
  'out':          { severity: 'critical', status: 'Out' },
  'inactive':     { severity: 'critical', status: 'Out' },
  'doubtful':     { severity: 'major',    status: 'Doubtful' },
  'questionable': { severity: 'minor',    status: 'Questionable' },
  'probable':     { severity: 'minor',    status: 'Questionable' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const _normalizeKey = (name = '') =>
  String(name)
    .toLowerCase()
    .replace(/[.'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const _severityToPrompt = (status, severity, reason) => {
  if (!status) return null;
  if (status === 'Out')      return `Player OUT — ${reason || 'injury'}`;
  if (status === 'Doubtful') return `Player doubtful, may not play`;
  if (severity === 'minor')  return `Player day-to-day, minor injury`;
  return `Player injury: ${reason || status}`;
};

// ── MLB injury resolution ─────────────────────────────────────────────────────

async function _getMLBTeamInjuredList(teamName) {
  if (!teamName) return [];

  const cacheKey = `injury:mlb:team:${_normalizeKey(teamName)}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const teamId = await mlbStatsClient.getTeamIdByName(teamName);
  if (!teamId) return [];

  const roster = await mlbStatsClient.getInjuredListForTeam(teamId);
  await cacheSet(cacheKey, roster, INJURY_CACHE_TTL);
  return roster;
}

function _parseMLBRosterEntry(entry) {
  const description = (entry?.status?.description || '').toLowerCase();

  // Skip active / non-IL entries
  if (!description || description === 'active') return null;

  for (const [keyword, tier] of Object.entries(MLB_SEVERITY_MAP)) {
    if (description.includes(keyword)) {
      return {
        status:   tier.status,
        severity: tier.severity,
        reason:   entry.status.description,
      };
    }
  }

  // Unknown IL entry → treat as Out
  return {
    status:   'Out',
    severity: 'major',
    reason:   entry.status.description,
  };
}

// ── NBA injury resolution (API-Sports) ───────────────────────────────────────

let _nbaSportsClient = null;
const _getNBAClient = () => {
  if (!_nbaSportsClient) _nbaSportsClient = new ApiSportsClient('nba');
  return _nbaSportsClient;
};

async function _getNBAInjuriesForGame(game) {
  const cacheKey = `injury:nba:game:${game?.oddsEventId || _normalizeKey([game?.homeTeamName, game?.awayTeamName].join('_'))}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const client  = _getNBAClient();
    const season  = new Date().getFullYear();
    const res     = await client.get('/injuries', { league: API_SPORTS_LEAGUES.nba, season });
    const entries = res?.response || [];
    await cacheSet(cacheKey, entries, INJURY_CACHE_TTL);
    return entries;
  } catch (err) {
    logger.warn('[injuryService] NBA injury fetch failed', { error: err.message });
    return [];
  }
}

function _parseNBAEntry(entry) {
  const statusRaw = (entry?.player?.status || entry?.status || '').toLowerCase().trim();
  const reason    = entry?.comment || entry?.description || entry?.type || null;

  const tier = NBA_STATUS_MAP[statusRaw];
  if (!tier) return null;

  return { ...tier, reason };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether this service has injury data for a sport.
 */
function isInjurySportSupported(sport) {
  return SUPPORTED_SPORTS.has(sport) && INJURY_SERVICES[sport] !== null;
}

/**
 * Get a Map of normalized player name → injury for all relevant players in a game.
 * Used by injuryRefresh.job for bulk updates.
 *
 * @param {{ homeTeamName?: string, awayTeamName?: string, oddsEventId?: string }} gameCtx
 * @param {string} sport
 * @returns {Promise<Map<string, {status,severity,reason}>>}
 */
async function getInjuryStatusesForGame(gameCtx, sport) {
  const result = new Map();

  if (!isInjurySportSupported(sport)) return result;

  try {
    if (sport === 'mlb') {
      const teams = [gameCtx.homeTeamName, gameCtx.awayTeamName].filter(Boolean);
      for (const teamName of teams) {
        const roster = await _getMLBTeamInjuredList(teamName);
        for (const entry of roster) {
          const injury = _parseMLBRosterEntry(entry);
          if (!injury) continue;
          const key = _normalizeKey(entry?.person?.fullName);
          if (key) result.set(key, injury);
        }
      }
    } else if (sport === 'nba') {
      const entries = await _getNBAInjuriesForGame(gameCtx);
      for (const entry of entries) {
        const injury = _parseNBAEntry(entry);
        if (!injury) continue;
        const name = entry?.player?.name || entry?.player?.fullName || '';
        const key  = _normalizeKey(name);
        if (key) result.set(key, injury);
      }
    }
  } catch (err) {
    logger.error('[injuryService] getInjuryStatusesForGame failed', { sport, error: err.message });
  }

  return result;
}

/**
 * Get injury status for a single player.
 *
 * @param {string} playerName
 * @param {{ homeTeamName?: string, awayTeamName?: string }} game
 * @param {string} sport
 * @returns {Promise<{status,severity,reason}|null>}
 */
async function getPlayerInjuryStatus(playerName, game, sport) {
  if (!isInjurySportSupported(sport) || !playerName) return null;

  const map = await getInjuryStatusesForGame(game, sport);
  return map.get(_normalizeKey(playerName)) || null;
}

/**
 * Get a short string for injection into the AI prompt.
 *
 * @param {string} playerName
 * @param {object} game
 * @param {string} sport
 * @returns {Promise<string|null>}
 */
async function getInjuryPromptContext(playerName, game, sport) {
  const injury = await getPlayerInjuryStatus(playerName, game, sport);
  if (!injury) return null;
  return _severityToPrompt(injury.status, injury.severity, injury.reason);
}

module.exports = {
  isInjurySportSupported,
  getInjuryStatusesForGame,
  getPlayerInjuryStatus,
  getInjuryPromptContext,
};

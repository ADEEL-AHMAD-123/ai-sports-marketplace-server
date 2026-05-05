/**
 * NHLInjuryService.js — NHL injury data via ESPN's public sports API
 *
 * SOURCE: https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries
 *   - No API key, free, returns league-wide injury list grouped by team.
 *   - Updated several times per day; we cache 30 minutes to keep the
 *     prop watcher cycle from hammering the endpoint.
 *
 * Status normalization (ESPN -> internal tier):
 *   "Out" | "IR" | "Suspension"  → critical / Out
 *   "Doubtful"                   → major    / Doubtful
 *   "Questionable" | "Probable"  → minor    / Questionable
 *   "Day-To-Day"                 → minor    / Day-to-Day
 *
 * If the ESPN endpoint fails or rate-limits, we return empty maps so the
 * downstream prop pipeline keeps working — degraded but not broken.
 */

const axios = require('axios');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const ESPN_INJURY_URL = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';
const CACHE_TTL = 30 * 60; // 30min
const TIMEOUT_MS = 8_000;

const STATUS_MAP = {
  'out':           { severity: 'critical', status: 'Out' },
  'ir':            { severity: 'critical', status: 'Out' },
  'suspension':    { severity: 'critical', status: 'Out' },
  'long-term-injured-reserve': { severity: 'critical', status: 'Out' },
  'ltir':          { severity: 'critical', status: 'Out' },
  'doubtful':      { severity: 'major',    status: 'Doubtful' },
  'questionable':  { severity: 'minor',    status: 'Questionable' },
  'probable':      { severity: 'minor',    status: 'Questionable' },
  'day-to-day':    { severity: 'minor',    status: 'Day-to-Day' },
  'gtd':           { severity: 'minor',    status: 'Day-to-Day' },
};

const _normName = (s = '') =>
  String(s).toLowerCase().replace(/[.''\-]/g, ' ').replace(/\s+/g, ' ').trim();

// Pull league-wide injuries once and cache by team abbrev.
// Returns Map<teamAbbrev, Map<normName, {status, severity, reason, position}>>
async function _fetchLeagueInjuryIndex() {
  const cacheKey = 'nhl:injury:espn:league:v1';
  const cached   = await cacheGet(cacheKey);
  if (cached) {
    const out = new Map();
    for (const [team, players] of Object.entries(cached)) {
      out.set(team, new Map(Object.entries(players)));
    }
    return out;
  }

  const result = new Map();
  try {
    const res = await axios.get(ESPN_INJURY_URL, { timeout: TIMEOUT_MS });
    const teams = res.data?.injuries || [];

    for (const teamEntry of teams) {
      const abbrev = (teamEntry?.abbreviation || teamEntry?.team?.abbreviation || '')
        .toUpperCase();
      if (!abbrev) continue;

      const playerMap = new Map();
      for (const inj of (teamEntry.injuries || [])) {
        // ESPN responses use various nesting; cover the common shapes.
        const playerName =
          inj?.athlete?.displayName ||
          inj?.athlete?.fullName ||
          inj?.player?.displayName ||
          inj?.player?.fullName ||
          '';
        const statusRaw  = (inj?.status || inj?.type?.name || '').toLowerCase().trim();
        const tier       = STATUS_MAP[statusRaw];
        if (!playerName || !tier) continue;
        const reason   = inj?.shortComment || inj?.longComment || inj?.details?.type || null;
        const position = inj?.athlete?.position?.abbreviation || null;

        playerMap.set(_normName(playerName), {
          ...tier,
          reason,
          position,
        });
      }

      if (playerMap.size) result.set(abbrev, playerMap);
    }

    // Cache as serializable object-of-objects
    const serial = {};
    for (const [team, playerMap] of result.entries()) {
      serial[team] = Object.fromEntries(playerMap);
    }
    await cacheSet(cacheKey, serial, CACHE_TTL);
  } catch (err) {
    logger.warn('[NHLInjuryService] ESPN fetch failed (non-fatal)', { error: err.message });
    return new Map();
  }
  return result;
}

/**
 * Get an injury map for a single game's two teams.
 *
 * @param {{ homeTeamName, awayTeamName }} gameCtx
 * @returns {Promise<Map<normName, {status, severity, reason, position}>>}
 */
async function getInjuryMap(gameCtx = {}) {
  const NHLStatsClient = require('./NHLStatsClient'); // lazy to avoid cycles
  const homeAbbr = NHLStatsClient.getTeamAbbrev(gameCtx.homeTeamName);
  const awayAbbr = NHLStatsClient.getTeamAbbrev(gameCtx.awayTeamName);

  const league = await _fetchLeagueInjuryIndex();

  const merged = new Map();
  for (const abbr of [homeAbbr, awayAbbr]) {
    if (!abbr) continue;
    const teamMap = league.get(abbr);
    if (!teamMap) continue;
    for (const [name, entry] of teamMap.entries()) {
      merged.set(name, entry);
    }
  }
  return merged;
}

async function getPlayerInjury(playerName, gameCtx = {}) {
  if (!playerName) return null;
  const map = await getInjuryMap(gameCtx);
  return map.get(_normName(playerName)) || null;
}

async function getInjuryPromptContext(playerName, gameCtx = {}) {
  const injury = await getPlayerInjury(playerName, gameCtx);
  if (!injury) return null;
  const reason = injury.reason ? ` — ${injury.reason}` : '';
  if (injury.status === 'Out')         return `Player OUT${reason}`;
  if (injury.status === 'Doubtful')    return `Doubtful — likely scratched${reason}`;
  if (injury.status === 'Questionable')return `Questionable${reason}`;
  if (injury.status === 'Day-to-Day')  return `Day-to-day${reason}`;
  return null;
}

module.exports = {
  getInjuryMap,
  getPlayerInjury,
  getInjuryPromptContext,
};

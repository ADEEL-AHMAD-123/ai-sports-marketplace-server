/**
 * ESPNPlayerResolver.js — Odds-API player name → ESPN athlete ID resolver
 *
 * The Odds API gives us player names as strings ("Christian McCaffrey").
 * ESPN's gamelog endpoint needs an athlete ID (integer). This resolver
 * bridges the gap by:
 *
 *   1. Looking up the two teams involved in the game (home + away) in
 *      ESPN's team registry
 *   2. Fetching both teams' rosters
 *   3. Matching the player name against roster entries with fuzzy rules
 *      (accents, hyphens, abbreviated first names, common suffixes)
 *   4. Caching the resolved (playerName → athleteId) mapping in Redis
 *      permanently — a player's ID doesn't change over their career even
 *      when they change teams
 *
 * Cache keys:
 *   espn:player:{sportKey}:{normalizedName}      → athleteId (long TTL)
 *   espn:teams:{sportKey}                         → team registry (24h TTL)
 *   espn:roster:{sportKey}:{teamId}               → team roster (24h TTL)
 *
 * Design notes:
 *   • Team registry and rosters are cached separately so a single-team
 *     lookup doesn't require re-fetching every team.
 *   • Rosters expire daily so trades/promotions get picked up.
 *   • Individual player mappings are cached with a 30-day TTL — long
 *     enough to be free during normal play, short enough to self-heal
 *     if a player retires or IDs shift.
 */

const ESPNClient        = require('./ESPNClient');
const { cacheGet, cacheSet } = require('../../config/redis');
const logger            = require('../../config/logger');

const PLAYER_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days
const TEAM_CACHE_TTL   = 24 * 60 * 60;      // 24 hours
const ROSTER_CACHE_TTL = 24 * 60 * 60;      // 24 hours

// Normalize a name for comparison: lowercase, strip accents, remove
// punctuation, collapse whitespace. Applied to both sides of the match.
const normName = (s = '') => String(s)
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')      // strip diacritics (é → e)
  .toLowerCase()
  .replace(/[.'’\-]/g, ' ')        // punctuation → space
  .replace(/\bjr\b|\bsr\b|\bii+\b|\biv\b/g, ' ')  // strip Jr/Sr/II/IV suffixes
  .replace(/\s+/g, ' ')
  .trim();

// A player name matches a roster entry if:
//   - Full normalized names are identical, OR
//   - Last names match AND either first names match OR the roster's first
//     name starts with the query's first-name initial (handles "C.
//     McCaffrey" vs "Christian McCaffrey")
const isMatch = (queryName, rosterName) => {
  const q = normName(queryName);
  const r = normName(rosterName);
  if (!q || !r) return false;
  if (q === r) return true;

  const qParts = q.split(' ');
  const rParts = r.split(' ');
  if (!qParts.length || !rParts.length) return false;

  const qLast = qParts[qParts.length - 1];
  const rLast = rParts[rParts.length - 1];
  if (qLast !== rLast) return false;

  const qFirst = qParts[0];
  const rFirst = rParts[0];
  if (qFirst === rFirst) return true;
  // Handle abbreviated first name (single letter, possibly with a trailing dot already stripped)
  if (qFirst.length === 1 && rFirst.startsWith(qFirst)) return true;
  if (rFirst.length === 1 && qFirst.startsWith(rFirst)) return true;
  return false;
};

class ESPNPlayerResolver {

  /**
   * Resolve a player name to an ESPN athlete ID.
   *
   * @param {object} opts
   * @param {string} opts.sportKey      — 'nfl' | 'nba' | 'soccer_mls' | …
   * @param {string} opts.playerName    — from The Odds API prop
   * @param {string} [opts.homeTeamName] — game context, narrows the search
   * @param {string} [opts.awayTeamName]
   * @returns {Promise<string|null>}
   */
  static async resolve({ sportKey, playerName, homeTeamName, awayTeamName }) {
    if (!sportKey || !playerName) return null;

    const cacheKey = `espn:player:${sportKey}:${normName(playerName)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Look up team IDs in ESPN's registry
    const teamRegistry = await this._getTeamRegistry(sportKey);
    const teamIds = [];
    for (const teamName of [homeTeamName, awayTeamName].filter(Boolean)) {
      const teamId = this._findTeamId(teamRegistry, teamName);
      if (teamId) teamIds.push(teamId);
    }

    if (!teamIds.length) {
      logger.debug(`[ESPNPlayerResolver] No team match for game — sport=${sportKey} home="${homeTeamName}" away="${awayTeamName}"`);
      return null;
    }

    // Search both rosters (in parallel) for the player
    const rosters = await Promise.all(
      teamIds.map(id => this._getRoster(sportKey, id).catch(err => {
        logger.debug(`[ESPNPlayerResolver] Roster fetch failed for team ${id}`, { error: err.message });
        return [];
      }))
    );

    for (const roster of rosters) {
      for (const player of roster) {
        if (isMatch(playerName, player.displayName)) {
          await cacheSet(cacheKey, player.id, PLAYER_CACHE_TTL);
          return player.id;
        }
      }
    }

    // Not on either roster — could be a mid-season signing not yet in the
    // API-visible roster, an inactive player, or a name mismatch. Log
    // once so we can spot chronic misses.
    logger.debug(
      `[ESPNPlayerResolver] No roster match — sport=${sportKey} player="${playerName}" ` +
      `teams=[${[homeTeamName, awayTeamName].filter(Boolean).join(', ')}]`
    );
    return null;
  }

  // ─── Registry helpers ──────────────────────────────────────────────────

  static async _getTeamRegistry(sportKey) {
    const cacheKey = `espn:teams:${sportKey}`;
    const cached = await cacheGet(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;

    const teams = await ESPNClient.listTeams(sportKey);
    if (teams.length > 0) {
      await cacheSet(cacheKey, teams, TEAM_CACHE_TTL);
    }
    return teams;
  }

  static async _getRoster(sportKey, teamId) {
    const cacheKey = `espn:roster:${sportKey}:${teamId}`;
    const cached = await cacheGet(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;

    const roster = await ESPNClient.listRoster(sportKey, teamId);
    if (roster.length > 0) {
      await cacheSet(cacheKey, roster, ROSTER_CACHE_TTL);
    }
    return roster;
  }

  /**
   * Find an ESPN team ID from a name that might come from The Odds API
   * (which often uses slightly different names than ESPN). Tries exact
   * name, location, and short-name matches.
   */
  static _findTeamId(registry, name) {
    if (!name) return null;
    const target = normName(name);
    for (const t of registry) {
      const candidates = [t.displayName, t.location, t.shortName].filter(Boolean);
      for (const c of candidates) {
        if (normName(c) === target) return t.id;
      }
    }
    // Fuzzier fallback — substring match on displayName (handles "NY
    // Giants" vs "New York Giants", "LA Rams" vs "Los Angeles Rams")
    for (const t of registry) {
      const dn = normName(t.displayName);
      if (dn && (dn.includes(target) || target.includes(dn))) return t.id;
    }
    return null;
  }

  // Exposed for tests / debug
  static _normName = normName;
  static _isMatch = isMatch;
}

module.exports = ESPNPlayerResolver;

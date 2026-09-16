/**
 * ESPNClient.js — ESPN Public API client (free, no key required)
 *
 * Source:   site.api.espn.com (ESPN's public JSON API)
 * Used by:  dozens of open-source sports apps (sportsdataverse, espn-api, etc.)
 * Auth:     None — completely public
 * Limits:   No official ceiling; ESPN throttles at the CDN. We self-throttle
 *           and cache aggressively to stay well within reasonable use.
 *
 * COVERAGE (relevant to us):
 *   Sport-league keys are what ESPN uses in the URL path:
 *     nfl    → football/nfl
 *     nba    → basketball/nba
 *     mlb    → baseball/mlb          (we already use MLB Stats API, keep as-is)
 *     nhl    → hockey/nhl            (we already use NHL Stats API, keep as-is)
 *     mls    → soccer/usa.1
 *     epl    → soccer/eng.1
 *     laliga → soccer/esp.1
 *     ...
 *
 * COMMON ENDPOINTS:
 *   GET /apis/site/v2/sports/{sport}/{league}/teams
 *     → List every team in the league with numeric IDs + names
 *
 *   GET /apis/site/v2/sports/{sport}/{league}/teams/{teamId}/roster
 *     → Every player currently on the team's roster with their athlete IDs
 *
 *   GET /apis/site/v2/sports/{sport}/{league}/teams/{teamId}/schedule?season={yr}
 *     → Team schedule for a season with per-game IDs and status
 *
 *   GET /apis/site/web/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog?season={yr}
 *     → Player game log with per-game stat breakdown (the one we actually need)
 *
 * NOTE on hosts: ESPN uses TWO base hosts depending on the endpoint family.
 *   site.api.espn.com/apis/site/v2/…            → team/roster/schedule
 *   site.web.api.espn.com/apis/common/v3/…      → athlete gamelogs, splits
 * The `get()` helper picks the right host based on the leading path segment.
 */

const axios  = require('axios');
const logger = require('../../config/logger');

const SITE_API_BASE = 'https://site.api.espn.com';       // /apis/site/v2/...
const WEB_API_BASE  = 'https://site.web.api.espn.com';   // /apis/common/v3/...

// Sport → ESPN URL path prefix. Extend as we add adapters.
const SPORT_LEAGUE_PATH = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  // Soccer needs an explicit league key — pass one in via caller since a
  // single "sport=soccer" can span EPL, MLS, La Liga, etc.
  soccer_mls:       'soccer/usa.1',
  soccer_epl:       'soccer/eng.1',
  soccer_laliga:    'soccer/esp.1',
  soccer_bundesliga:'soccer/ger.1',
  soccer_serie_a:   'soccer/ita.1',
  soccer_ligue_1:   'soccer/fra.1',
};

// Simple self-throttle so a burst of prop-scoring doesn't spam ESPN's edge.
// ESPN publishes no official rate limit, but community consensus is ~60
// requests per minute per IP is safe. We conservatively pace at 20/sec.
const MIN_MS_BETWEEN_REQUESTS = parseInt(process.env.ESPN_MIN_MS_BETWEEN_REQUESTS || '50', 10);
let lastRequestAt = 0;
const throttle = async () => {
  const now = Date.now();
  const wait = Math.max(0, MIN_MS_BETWEEN_REQUESTS - (now - lastRequestAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
};

// Retry policy for transient failures (5xx, network). 4xx is not retried —
// they mean the request itself was wrong (bad athlete ID, wrong season).
const shouldRetry = (err) => {
  const status = err.response?.status;
  if (!status) return true;                     // network / timeout
  if (status >= 500 && status <= 599) return true;
  if (status === 429) return true;              // rate limited
  return false;
};

class ESPNClient {

  /**
   * Look up the URL path prefix for a sport/league combination.
   * Returns something like "football/nfl" or "soccer/usa.1".
   */
  static leaguePath(sportKey) {
    const path = SPORT_LEAGUE_PATH[sportKey];
    if (!path) throw new Error(`[ESPNClient] Unknown sportKey: "${sportKey}"`);
    return path;
  }

  /**
   * Low-level GET. Prefers the site.web.api host for athlete/gamelog paths
   * (which require it) and defaults to site.api for everything else.
   *
   * @param {string} path      Full URL path (e.g. "/apis/site/v2/sports/football/nfl/teams")
   * @param {object} [params]  Query params
   * @param {object} [opts]
   * @param {boolean} [opts.useWebHost=false]  Use site.web.api.espn.com host
   */
  static async get(path, params = {}, opts = {}) {
    const host = opts.useWebHost ? WEB_API_BASE : SITE_API_BASE;
    const url  = `${host}${path}`;

    const maxAttempts = Math.max(1, parseInt(process.env.ESPN_MAX_ATTEMPTS || '3', 10));
    // Real browser User-Agent + Accept. Node's default `axios/1.x` UA
    // gets 403'd by many CDNs (Akamai, Cloudflare in front of ESPN).
    // A stable desktop UA is safe and mimics what fantasy/scraper apps use.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    let attempt = 0;
    while (true) {
      attempt += 1;
      await throttle();
      try {
        const res = await axios.get(url, { params, timeout: 10000, headers });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        if (attempt >= maxAttempts || !shouldRetry(err)) {
          logger.error(`[ESPN] ${path} failed`, {
            status,
            attempt,
            error: err.message,
            params,
          });
          throw err;
        }
        const backoffMs = Math.min(5000, 250 * (2 ** (attempt - 1)));
        logger.warn(`[ESPN] ${path} attempt ${attempt} failed (${status || 'network'}), retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }

  // ─── Convenience helpers for common resource paths ──────────────────────

  /**
   * List every team in a league.
   * Returns [{ id, displayName, abbreviation, location }]
   */
  static async listTeams(sportKey) {
    const leaguePath = this.leaguePath(sportKey);
    const data = await this.get(`/apis/site/v2/sports/${leaguePath}/teams`);
    // ESPN nests teams under sports[0].leagues[0].teams — each entry has .team
    const teamsWrapped = data?.sports?.[0]?.leagues?.[0]?.teams || [];
    return teamsWrapped.map(entry => {
      const t = entry?.team || {};
      return {
        id:            String(t.id || ''),
        displayName:   t.displayName || t.name || null,
        abbreviation:  t.abbreviation || null,
        location:      t.location || null,
        shortName:     t.shortDisplayName || null,
      };
    }).filter(t => t.id);
  }

  /**
   * Fetch a single team's active roster.
   * Returns [{ id, displayName, position, ... }]
   */
  static async listRoster(sportKey, teamId) {
    if (!teamId) return [];
    const leaguePath = this.leaguePath(sportKey);
    const data = await this.get(`/apis/site/v2/sports/${leaguePath}/teams/${teamId}/roster`);
    // Roster shape differs slightly by sport — sometimes flat `athletes`,
    // sometimes grouped by position under `athletes[].items`. Handle both.
    const buckets = data?.athletes || [];
    const flat = [];
    for (const bucket of buckets) {
      const items = Array.isArray(bucket?.items) ? bucket.items : [bucket];
      for (const a of items) {
        if (!a || !a.id) continue;
        flat.push({
          id:           String(a.id),
          displayName:  a.displayName || a.fullName || `${a.firstName || ''} ${a.lastName || ''}`.trim(),
          firstName:    a.firstName || null,
          lastName:     a.lastName || null,
          position:     a.position?.abbreviation || a.position?.name || null,
          jersey:       a.jersey || null,
        });
      }
    }
    return flat;
  }

  /**
   * Fetch a player's per-game log for a season.
   * Uses the "web api" host — the primary "site.api" host doesn't expose
   * gamelogs. Returns whatever ESPN sends; each sport-specific adapter
   * knows how to walk its own schema to pull out the stats it needs.
   */
  static async gamelog(sportKey, athleteId, season) {
    if (!athleteId) return null;
    const leaguePath = this.leaguePath(sportKey);
    const params = {};
    if (season) params.season = season;
    return this.get(
      `/apis/common/v3/sports/${leaguePath}/athletes/${athleteId}/gamelog`,
      params,
      { useWebHost: true }
    );
  }
}

module.exports = ESPNClient;

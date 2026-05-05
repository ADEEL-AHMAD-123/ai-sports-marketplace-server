/**
 * NHLAdapter.js — NHL player props + stats adapter
 *
 * PROPS:   The Odds API (same as NBA/MLB)
 * STATS:   Official NHL Stats API (api-web.nhle.com/v1) via NHLStatsClient
 *
 * FLOW:
 *   fetchProps(oddsEventId)     → The Odds API player props
 *   normalizeProp(raw)          → { playerName, statType, line, ... }
 *   fetchPlayerStats({ playerName, homeTeamName, awayTeamName })
 *   resolvePlayerTeam({ playerName, homeTeamName, awayTeamName })
 *                               → { teamAbbrev, side: 'home'|'away'|null }
 *   applyFormulas(stats, type)  → NHLFormulas processed stats
 *   buildPrompt(params)         → AI prompt with goalie/team context
 */

const axios              = require('axios');
const NHLStatsClient     = require('./NHLStatsClient');
const { applyNHLFormulas, buildNHLPrompt } = require('./NHLFormulas');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger             = require('../../../config/logger');

const STATS_CACHE_TTL = 4 * 60 * 60; // 4h

const ODDS_API_KEY  = process.env.THE_ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

const PROP_MARKETS = [
  'player_shots_on_goal',
  'player_goals',
  'player_assists',
  'player_points',
];

const MARKET_TO_STAT = {
  player_shots_on_goal: 'shots_on_goal',
  player_goals:         'goals',
  player_assists:       'assists',
  player_points:        'points',
};

// Bounded LRU-ish set with TTL semantics for "unavailable" event-id logging
class _BoundedTtlSet {
  constructor({ max = 2000, ttlMs = 30 * 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> expiry timestamp
  }
  has(key) {
    const exp = this.map.get(key);
    if (!exp) return false;
    if (exp < Date.now()) { this.map.delete(key); return false; }
    return true;
  }
  add(key) {
    this.map.set(key, Date.now() + this.ttlMs);
    if (this.map.size > this.max) {
      // Drop oldest (Map preserves insertion order)
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
}

class NHLAdapter {
  constructor() {
    this.sport = 'nhl';
    this._fetchPropsUnavailableLogged = new _BoundedTtlSet({ max: 2000, ttlMs: 30 * 60_000 });
  }

  // ── Schedule (The Odds API) ───────────────────────────────────────────────

  async fetchSchedule() {
    if (!ODDS_API_KEY) {
      logger.warn('[NHLAdapter] THE_ODDS_API_KEY not set — fetchSchedule skipped');
      return [];
    }
    try {
      const res = await axios.get(`${ODDS_API_BASE}/sports/icehockey_nhl/events`, {
        params: { apiKey: ODDS_API_KEY },
        timeout: 10_000,
      });
      const games = Array.isArray(res.data) ? res.data : [];
      logger.info(`✅ [NHL] ${games.length} games`);
      return games.map(g => this.normalizeGame(g));
    } catch (err) {
      logger.error('[NHLAdapter] fetchSchedule failed', { error: err.message });
      throw err;
    }
  }

  normalizeGame(rawGame) {
    const { getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');
    const home = rawGame.home_team;
    const away = rawGame.away_team;
    return {
      sport:       'nhl',
      league:      'NHL',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:         home,
        abbreviation: getTeamAbbr('nhl', home) || null,
        logoUrl:      getTeamLogoUrl('nhl', home) || getApiSportsLogoUrl('nhl', home) || null,
      },
      awayTeam: {
        name:         away,
        abbreviation: getTeamAbbr('nhl', away) || null,
        logoUrl:      getTeamLogoUrl('nhl', away) || getApiSportsLogoUrl('nhl', away) || null,
      },
      startTime: new Date(rawGame.commence_time),
      status:    'scheduled',
    };
  }

  // ── Props (The Odds API) ─────────────────────────────────────────────────

  async fetchProps(oddsEventId) {
    if (!ODDS_API_KEY) {
      logger.warn('[NHLAdapter] THE_ODDS_API_KEY not set');
      return [];
    }

    try {
      const url = `${ODDS_API_BASE}/sports/icehockey_nhl/events/${oddsEventId}/odds`;
      const params = {
        apiKey: ODDS_API_KEY,
        markets: PROP_MARKETS.join(','),
        regions: 'us',
        oddsFormat: 'american',
      };

      const res = await axios.get(url, { params, timeout: 10_000 });
      const event = res.data;
      const allProps = [];

      for (const bm of (event.bookmakers || [])) {
        for (const mkt of (bm.markets || [])) {
          if (!PROP_MARKETS.includes(mkt.key)) continue;
          for (const outcome of (mkt.outcomes || [])) {
            if (outcome.description && outcome.point != null) {
              allProps.push({
                oddsEventId,
                playerName: outcome.description,
                market: mkt.key,
                line: outcome.point,
                price: outcome.price,
                bookmaker: bm.key,
                sport: 'nhl',
              });
            }
          }
        }
      }

      return allProps;
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        const eventKey = String(oddsEventId || '');
        if (eventKey && !this._fetchPropsUnavailableLogged.has(eventKey)) {
          logger.info('[NHLAdapter] fetchProps event unavailable', { oddsEventId: eventKey, status });
          this._fetchPropsUnavailableLogged.add(eventKey);
        }
        return [];
      }
      if (status === 422) {
        logger.info('[NHLAdapter] fetchProps markets unavailable', { oddsEventId, status });
        return [];
      }
      logger.warn('[NHLAdapter] fetchProps failed', {
        oddsEventId,
        status: status || null,
        error: err.message,
      });
      return [];
    }
  }

  normalizeProp(rawProp) {
    return {
      ...rawProp,
      statType: MARKET_TO_STAT[rawProp.market] || rawProp.market,
      sport:    'nhl',
    };
  }

  async fetchFinalEventIds({ daysFrom = 3 } = {}) {
    if (!ODDS_API_KEY) return [];

    try {
      const url = `${ODDS_API_BASE}/sports/icehockey_nhl/scores`;
      const res = await axios.get(url, {
        params: { apiKey: ODDS_API_KEY, daysFrom },
        timeout: 10000,
      });
      const games = Array.isArray(res.data) ? res.data : [];
      return games
        .filter(g => g?.completed === true && g?.id)
        .map(g => String(g.id));
    } catch (err) {
      logger.warn('⚠️ [NHLAdapter] fetchFinalEventIds failed', { error: err.message });
      return [];
    }
  }

  async fetchCurrentLine(eventId, playerName, statType) {
    try {
      const props = await this.fetchProps(eventId);
      const target = NHLStatsClient.normName(playerName);
      const match = props.find(p =>
        NHLStatsClient.normName(p.playerName) === target &&
        MARKET_TO_STAT[p.market] === statType
      );
      return match
        ? { line: match.line, isAvailable: true }
        : { line: null, isAvailable: false };
    } catch {
      return { line: null, isAvailable: false };
    }
  }

  // ── Stats (Official NHL Stats API) ───────────────────────────────────────

  /**
   * Fetch player game log from official NHL Stats API.
   *
   * @param {{ playerName, homeTeamName, awayTeamName }} params
   * @returns {Promise<Array>} normalized game log rows
   */
  async fetchPlayerStats({ playerName, homeTeamName, awayTeamName }) {
    if (!playerName) return [];

    // Team-aware cache key prevents collisions for same surname on different teams.
    const teamsKey = [homeTeamName, awayTeamName]
      .filter(Boolean)
      .map(NHLStatsClient.getTeamAbbrev)
      .filter(Boolean)
      .sort()
      .join('-') || 'noteam';
    const cacheKey = `nhl:stats:${teamsKey}:${NHLStatsClient.normName(playerName)}`;
    const cached   = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    try {
      const playerInfo = await NHLStatsClient.resolvePlayerId(
        playerName,
        homeTeamName,
        awayTeamName
      );

      if (!playerInfo?.id) {
        logger.debug(`[NHLAdapter] No player ID for "${playerName}"`);
        return [];
      }

      const log = await NHLStatsClient.getPlayerGameLog(playerInfo.id);

      if (!log.length) {
        logger.debug(`[NHLAdapter] Empty game log for "${playerName}" (id=${playerInfo.id})`);
        return [];
      }

      // Decorate the array with the resolved team context (non-enumerable so it
      // doesn't pollute serialization but consumers can still read it).
      Object.defineProperty(log, '__teamAbbrev', { value: playerInfo.teamAbbrev || null });
      Object.defineProperty(log, '__playerInfo', { value: playerInfo });

      await cacheSet(cacheKey, log, STATS_CACHE_TTL);
      logger.info(`[NHLAdapter] Stats: "${playerName}" → ${log.length} games (id=${playerInfo.id}, team=${playerInfo.teamAbbrev || '?'})`);
      return log;

    } catch (err) {
      logger.error('[NHLAdapter] fetchPlayerStats failed', {
        playerName, error: err.message,
      });
      return [];
    }
  }

  /**
   * Resolve which side ('home' | 'away') a player belongs to.
   *
   * @param {{ playerName, homeTeamName, awayTeamName }} params
   * @returns {Promise<{ side: 'home'|'away'|null, teamAbbrev: string|null, playerInfo: Object|null }>}
   */
  async resolvePlayerTeam({ playerName, homeTeamName, awayTeamName }) {
    if (!playerName) return { side: null, teamAbbrev: null, playerInfo: null };
    try {
      const info = await NHLStatsClient.resolvePlayerId(playerName, homeTeamName, awayTeamName);
      if (!info?.teamAbbrev) return { side: null, teamAbbrev: null, playerInfo: info || null };

      const homeAbbr = NHLStatsClient.getTeamAbbrev(homeTeamName);
      const awayAbbr = NHLStatsClient.getTeamAbbrev(awayTeamName);

      let side = null;
      if (info.teamAbbrev === homeAbbr) side = 'home';
      else if (info.teamAbbrev === awayAbbr) side = 'away';

      return { side, teamAbbrev: info.teamAbbrev, playerInfo: info };
    } catch (err) {
      logger.debug('[NHLAdapter] resolvePlayerTeam failed', { playerName, error: err.message });
      return { side: null, teamAbbrev: null, playerInfo: null };
    }
  }

  // ── Formulas + Prompt ────────────────────────────────────────────────────

  applyFormulas(rawStats, statType, context = {}) {
    return applyNHLFormulas(rawStats, statType, context);
  }

  buildPrompt(params) {
    return buildNHLPrompt(params);
  }

  getRequiredStats() {
    return ['goals', 'assists', 'shots', 'toi', 'powerPlayGoals', 'plusMinus'];
  }
}

module.exports = NHLAdapter;

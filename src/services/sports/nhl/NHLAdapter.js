/**
 * NHLAdapter.js — NHL player props + stats adapter
 *
 * PROPS:   The Odds API (same as NBA/MLB)
 * STATS:   Official NHL Stats API (api-web.nhle.com/v1) via NHLStatsClient
 *          Free, no API key, official source used by NHL.com
 *          Replaces API-Sports Hockey which had no reliable player stat data
 *
 * FLOW:
 *   fetchProps(oddsEventId)     → The Odds API player props
 *   normalizeProp(raw)          → { playerName, statType, line, ... }
 *   fetchPlayerStats({          → NHLStatsClient game log
 *     playerName,
 *     homeTeamName,
 *     awayTeamName,
 *   })
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

class NHLAdapter {
  constructor() {
    this.sport = 'nhl';
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
    const { getTeamAbbr, getTeamLogoUrl } = require('../../shared/teamMaps');
    const home = rawGame.home_team;
    const away = rawGame.away_team;
    return {
      sport:       'nhl',
      league:      'NHL',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:         home,
        abbreviation: getTeamAbbr('nhl', home) || null,
        logoUrl:      getTeamLogoUrl('nhl', home) || null,
      },
      awayTeam: {
        name:         away,
        abbreviation: getTeamAbbr('nhl', away) || null,
        logoUrl:      getTeamLogoUrl('nhl', away) || null,
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

    const allProps = [];

    for (const market of PROP_MARKETS) {
      try {
        const url    = `${ODDS_API_BASE}/sports/icehockey_nhl/events/${oddsEventId}/odds`;
        const params = {
          apiKey:   ODDS_API_KEY,
          markets:  market,
          regions:  'us',
          oddsFormat: 'american',
        };

        const res   = await axios.get(url, { params, timeout: 10_000 });
        const event = res.data;

        // Extract player props from bookmaker markets
        for (const bm of (event.bookmakers || [])) {
          for (const mkt of (bm.markets || [])) {
            if (mkt.key !== market) continue;
            for (const outcome of (mkt.outcomes || [])) {
              if (outcome.description && outcome.point != null) {
                allProps.push({
                  oddsEventId,
                  playerName:  outcome.description,
                  market,
                  line:        outcome.point,
                  price:       outcome.price,
                  bookmaker:   bm.key,
                  sport:       'nhl',
                });
              }
            }
          }
        }

      } catch (err) {
        if (err.response?.status === 422) continue; // market not available
        logger.warn('[NHLAdapter] fetchProps market failed', { market, error: err.message });
      }
    }

    return allProps;
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
    const marketKey = Object.entries(MARKET_TO_STAT)
      .find(([, v]) => v === statType)?.[0] || 'player_shots_on_goal';

    try {
      const fakeEvent = { oddsEventId: eventId };
      const props     = await this.fetchProps(eventId);
      const match     = props.find(p =>
        p.playerName?.toLowerCase().trim() === playerName?.toLowerCase().trim() &&
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

    const cacheKey = `nhl:stats:${playerName.toLowerCase().replace(/\s+/g, '_')}`;
    const cached   = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    try {
      // Step 1: resolve NHL player ID from team rosters
      const playerInfo = await NHLStatsClient.resolvePlayerId(
        playerName,
        homeTeamName,
        awayTeamName
      );

      if (!playerInfo?.id) {
        logger.debug(`[NHLAdapter] No player ID for "${playerName}"`);
        return [];
      }

      // Step 2: fetch game log
      const log = await NHLStatsClient.getPlayerGameLog(playerInfo.id);

      if (!log.length) {
        logger.debug(`[NHLAdapter] Empty game log for "${playerName}" (id=${playerInfo.id})`);
        return [];
      }

      // Cache the final result
      await cacheSet(cacheKey, log, STATS_CACHE_TTL);
      logger.info(`[NHLAdapter] Stats fetched: "${playerName}" → ${log.length} games (id=${playerInfo.id})`);
      return log;

    } catch (err) {
      logger.error('[NHLAdapter] fetchPlayerStats failed', {
        playerName, error: err.message,
      });
      return [];
    }
  }

  // ── Formulas + Prompt ────────────────────────────────────────────────────

  applyFormulas(rawStats, statType, context = {}) {
    return applyNHLFormulas(rawStats, statType);
  }

  buildPrompt(params) {
    return buildNHLPrompt(params);
  }

  getRequiredStats() {
    return ['goals', 'assists', 'shots', 'toi', 'powerPlayGoals', 'plusMinus'];
  }
}

module.exports = NHLAdapter;


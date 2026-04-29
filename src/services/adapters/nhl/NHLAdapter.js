/**
 * NHLAdapter.js — NHL player props adapter
 *
 * DATA SOURCES:
 *   Props/odds: The Odds API Pro (market keys below)
 *   Player stats: API-Sports Hockey v1 (v1.hockey.api-sports.io)
 *     Same key as NBA. Free tier: 100/day.
 *     League ID: 57 (NHL), Season: current year
 *     No team param required — search by name works.
 *
 * PROP MARKETS (The Odds API market keys):
 *   player_shots_on_goal  → shots_on_goal
 *   player_goals          → goals
 *   player_assists        → assists
 *   player_points         → points  (goals + assists combined)
 *
 * NHL STAT FIELDS from API-Sports Hockey v1 /players/statistics:
 *   goals, assists, shots (shots on goal), penaltyMinutes,
 *   plusMinus, timeOnIce (MM:SS)
 *   NOTE: 'points' is not a direct field — computed as goals + assists
 *
 * PATTERN: Same name-based lookup as MLBAdapter.
 *   No player ID needed — ApiSportsClient searches by name.
 */

const axios           = require('axios');
const ApiSportsClient = require('../shared/ApiSportsClient');
const { applyNHLFormulas, buildNHLPrompt } = require('./NHLFormulas');
const { getTeamLogoUrl, getApiSportsLogoUrl } = require('../shared/teamMaps');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const STATS_CACHE_TTL = 4 * 60 * 60; // 4h

class NHLAdapter {
  constructor() {
    this.sport           = 'nhl';
    this.leagueId        = 57;
    this.oddsSportKey    = 'icehockey_nhl';
    this.propMarkets     = [
      'player_shots_on_goal',
      'player_goals',
      'player_assists',
      'player_points',   // g+a combined
    ];
    this.oddsApiQuotaRemaining = Infinity;
    this._client         = null;
  }

  _getClient() {
    if (!this._client) this._client = new ApiSportsClient('nhl');
    return this._client;
  }

  _getSeason() {
    const now = new Date();
    const yr  = now.getFullYear();
    // NHL season: Oct–Jun — current season year = start year
    return (now.getMonth() + 1) >= 10 ? yr : yr - 1;
  }

  // ─── Schedule ────────────────────────────────────────────────────────────

  async fetchSchedule() {
    try {
      logger.info('📅 [NHL] Fetching schedule...');
      const response = await axios.get(
        `${process.env.THE_ODDS_API_BASE_URL}/sports/${this.oddsSportKey}/events`,
        { params: { apiKey: process.env.THE_ODDS_API_KEY }, timeout: 10000 }
      );
      const games = response.data || [];
      logger.info(`✅ [NHL] ${games.length} games`);
      return games.map(g => this.normalizeGame(g));
    } catch (err) {
      logger.error('❌ [NHL] fetchSchedule failed', { error: err.message });
      throw err;
    }
  }

  normalizeGame(rawGame) {
    const homeTeam = rawGame.home_team;
    const awayTeam = rawGame.away_team;
    const homeLogoUrl = getTeamLogoUrl('nhl', homeTeam) || getApiSportsLogoUrl('nhl', homeTeam);
    const awayLogoUrl = getTeamLogoUrl('nhl', awayTeam) || getApiSportsLogoUrl('nhl', awayTeam);
    return {
      sport:       'nhl',
      league:      'NHL',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:        homeTeam,
        logoUrl:     homeLogoUrl,
        logo:        homeLogoUrl,
      },
      awayTeam: {
        name:        awayTeam,
        logoUrl:     awayLogoUrl,
        logo:        awayLogoUrl,
      },
      startTime: new Date(rawGame.commence_time),
      status:    'scheduled',
      venue:     { name: rawGame.venue || null },
    };
  }

  // ─── Odds API integration ────────────────────────────────────────────────

  async fetchProps(oddsEventId) {
    if (!this._quotaSafe()) return [];
    try {
      const marketsParam = this.propMarkets.join(',');
      const response = await axios.get(
        `${process.env.THE_ODDS_API_BASE_URL}/sports/${this.oddsSportKey}/events/${oddsEventId}/odds`,
        {
          params: {
            apiKey:      process.env.THE_ODDS_API_KEY,
            regions:     'us',
            markets:     marketsParam,
            oddsFormat:  'american',
          },
          timeout: 10000,
        }
      );
      this._trackQuota(response.headers);
      const props = this._extractProps(response.data, oddsEventId);
      logger.info(`✅ [NHL] ${props.length} props for event ${oddsEventId}`);
      return props;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 422) {
        logger.error(`🔑 [NHL] Odds API ${status} — quota exhausted`);
        this.oddsApiQuotaRemaining = 0;
        return [];
      }
      logger.error('❌ [NHL] fetchProps failed', { oddsEventId, error: err.message });
      return [];
    }
  }

  _extractProps(eventData, oddsEventId) {
    const NHL_MARKET_MAP = {
      player_shots_on_goal: 'shots_on_goal',
      player_goals:         'goals',
      player_assists:       'assists',
      player_points:        'points',
    };
    const props = [];
    for (const bk of eventData?.bookmakers || []) {
      for (const market of bk.markets || []) {
        const statType = NHL_MARKET_MAP[market.key];
        if (!statType) continue;

        const byPlayer = {};
        for (const o of market.outcomes || []) {
          const pn = o.description;
          if (!byPlayer[pn]) byPlayer[pn] = { playerName: pn, statType, bookmaker: bk.title, oddsEventId };
          if (o.name === 'Over')  { byPlayer[pn].line = o.point; byPlayer[pn].overOdds  = o.price; }
          if (o.name === 'Under') { byPlayer[pn].underOdds = o.price; }
        }
        for (const p of Object.values(byPlayer)) {
          if (p.line !== undefined && p.overOdds !== undefined) props.push(p);
        }
      }
      if (props.length > 0 && bk.title === 'DraftKings') break;
    }
    return props;
  }

  normalizeProp(rawProp) {
    return {
      sport:         'nhl',
      playerName:    rawProp.playerName,
      statType:      rawProp.statType,
      line:          rawProp.line,
      overOdds:      rawProp.overOdds,
      underOdds:     rawProp.underOdds,
      bookmaker:     rawProp.bookmaker,
      oddsEventId:   rawProp.oddsEventId,
      isAvailable:   true,
      lastUpdatedAt: new Date(),
    };
  }

  async fetchCurrentLine(eventId, playerName, statType) {
    const marketMap = {
      shots_on_goal: 'player_shots_on_goal',
      goals:         'player_goals',
      assists:       'player_assists',
      points:        'player_points',
    };
    const marketKey = marketMap[statType];
    if (!marketKey) return { line: null, isAvailable: false };
    try {
      const response = await axios.get(
        `${process.env.THE_ODDS_API_BASE_URL}/sports/${this.oddsSportKey}/events/${eventId}/odds`,
        {
          params: {
            apiKey:     process.env.THE_ODDS_API_KEY,
            regions:    'us',
            markets:    marketKey,
            oddsFormat: 'american',
          },
          timeout: 10000,
        }
      );
      const props = this._extractProps(response.data, eventId);
      const match = props.find(p =>
        p.playerName?.toLowerCase().trim() === playerName?.toLowerCase().trim() &&
        p.statType === statType
      );
      return match ? { line: match.line, isAvailable: true } : { line: null, isAvailable: false };
    } catch {
      return { line: null, isAvailable: false };
    }
  }

  _quotaSafe() {
    if (this.oddsApiQuotaRemaining <= 10) {
      if (this.oddsApiQuotaRemaining > 0) {
        logger.warn('[NHL] Quota too low — skipping');
        this.oddsApiQuotaRemaining = 0;
      }
      return false;
    }
    return true;
  }

  _trackQuota(headers) {
    const r = parseInt(headers?.['x-requests-remaining'], 10);
    if (!isNaN(r)) {
      this.oddsApiQuotaRemaining = r;
      if (r <= 10) logger.error(`🚨 [NHL] Odds API quota CRITICAL: ${r}`);
      else if (r <= 50) logger.warn(`⚠️  [NHL] Odds API quota LOW: ${r}`);
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  async fetchPlayerStats({ playerName, season = null }) {
    if (!playerName) return [];

    const yr       = season || this._getSeason();
    const cacheKey = `nhl:stats:${playerName.toLowerCase().replace(/\s+/g, '_')}:${yr}`;
    const cached   = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    try {
      const client  = this._getClient();
      const season2 = yr.toString();

      // Search for player by name
      const searchRes = await client.get('players', {
        search: playerName,
        league: this.leagueId,
        season: season2,
      });

      const players = Array.isArray(searchRes) ? searchRes : [];
      if (!players.length) {
        logger.debug(`[NHLAdapter] No player found for "${playerName}"`);
        return [];
      }

      // Best name match
      const normTarget = playerName.toLowerCase().replace(/[^a-z ]/g, '');
      const player     = players.find(p => {
        const full = `${p.firstname || ''} ${p.lastname || ''}`.toLowerCase().replace(/[^a-z ]/g, '');
        return full.trim() === normTarget;
      }) || players[0];

      if (!player?.id) return [];

      // Fetch game-by-game statistics
      const statsRes = await client.get('players/statistics', {
        id:     player.id,
        league: this.leagueId,
        season: season2,
      });

      const stats = Array.isArray(statsRes) ? statsRes : [];

      if (!stats.length) {
        logger.debug(`[NHLAdapter] No stats for "${playerName}" (id=${player.id})`);
        return [];
      }

      // Normalize to flat game-log format
      const normalized = stats.map(s => ({
        goals:         s.goals,
        assists:       s.assists,
        shots:         s.shots,
        shotsOnGoal:   s.shots,
        penaltyMinutes: s.penaltyMinutes,
        plusMinus:     s.plusMinus,
        timeOnIce:     s.timeOnIce || s.toi || null,
        date:          s.game?.date || s.date || null,
        gameId:        s.game?.id   || null,
      }));

      await cacheSet(cacheKey, normalized, STATS_CACHE_TTL);
      logger.info(`[NHLAdapter] Fetched ${normalized.length} games for "${playerName}"`, { yr });
      return normalized;

    } catch (err) {
      logger.error('[NHLAdapter] fetchPlayerStats failed', {
        playerName, error: err.message,
      });
      return [];
    }
  }

  // ─── Formulas + Prompt ───────────────────────────────────────────────────

  applyFormulas(rawStats, statType, context = {}) {
    return applyNHLFormulas(rawStats, statType);
  }

  buildPrompt(params) {
    return buildNHLPrompt(params);
  }
}

module.exports = NHLAdapter;
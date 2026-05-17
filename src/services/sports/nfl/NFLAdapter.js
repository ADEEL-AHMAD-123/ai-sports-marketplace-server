/**
 * NFLAdapter.js — NFL sport adapter
 *
 * DATA SOURCES:
 *  Props/Schedule → The Odds API (americanfootball_nfl)
 *  Stats          → API-Sports American Football v1
 */

const BaseAdapter = require('../../shared/BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const ApiSportsClient = require('../../shared/ApiSportsClient');
const { applyNFLFormulas, buildNFLPrompt } = require('./NFLFormulas');
const { getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');

const NFL_MARKET_MAP = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions',
  player_pass_tds: 'pass_tds',
  player_rush_reception_yds: 'rush_reception_yards',
};

class NFLAdapter extends BaseAdapter {
  constructor() {
    super('nfl');

    this.oddsApiBase = process.env.THE_ODDS_API_BASE_URL;
    this.oddsApiKey = process.env.THE_ODDS_API_KEY;
    this.oddsSportKey = 'americanfootball_nfl';
    this.propMarkets = Object.keys(NFL_MARKET_MAP);

    this.statsClient = new ApiSportsClient('nfl');

    this.oddsApiQuotaRemaining = Infinity;
    this.QUOTA_STOP_THRESHOLD = 10;
  }

  async fetchSchedule() {
    try {
      logger.info('📅 [NFL] Fetching schedule...');
      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events`,
        { params: { apiKey: this.oddsApiKey }, timeout: 10000 }
      );
      this._trackQuota(response.headers);
      const games = response.data || [];
      logger.info(`✅ [NFL] ${games.length} games`);
      return games.map((g) => this.normalizeGame(g));
    } catch (err) {
      logger.error('❌ [NFL] fetchSchedule failed', { error: err.message });
      throw err;
    }
  }

  async fetchFinalEventIds({ daysFrom = 3 } = {}) {
    try {
      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/scores`,
        {
          params: { apiKey: this.oddsApiKey, daysFrom },
          timeout: 10000,
        }
      );
      this._trackQuota(response.headers);
      const games = Array.isArray(response.data) ? response.data : [];
      return games
        .filter((g) => g?.completed === true && g?.id)
        .map((g) => String(g.id));
    } catch (err) {
      logger.warn('⚠️ [NFL] fetchFinalEventIds failed', { error: err.message });
      return [];
    }
  }

  async fetchProps(oddsEventId, { markets = null } = {}) {
    if (!this._quotaSafe()) return [];

    try {
      const marketsParam = markets
        ? (Array.isArray(markets) ? markets : [markets]).join(',')
        : this.propMarkets.join(',');

      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events/${oddsEventId}/odds`,
        {
          params: {
            apiKey: this.oddsApiKey,
            regions: 'us',
            markets: marketsParam,
            oddsFormat: 'american',
          },
          timeout: 10000,
        }
      );

      this._trackQuota(response.headers);
      const props = this._extractProps(response.data, oddsEventId);
      logger.info(`✅ [NFL] ${props.length} props for event ${oddsEventId}`);
      return props;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 422) {
        logger.error(`🔑 [NFL] Odds API ${status} — quota exhausted`);
        this.oddsApiQuotaRemaining = 0;
        return [];
      }
      if (status === 404) {
        logger.info('[NFL] fetchProps event unavailable', { oddsEventId, status });
        return [];
      }
      logger.error('❌ [NFL] fetchProps failed', { oddsEventId, error: err.message, status });
      throw err;
    }
  }

  async fetchCurrentLine(oddsEventId, playerName, statType) {
    const marketKey = Object.entries(NFL_MARKET_MAP).find(([, v]) => v === statType)?.[0];
    if (!marketKey) return { line: null, isAvailable: false };

    const props = await this.fetchProps(oddsEventId, { markets: marketKey });
    const match = props.find((p) =>
      p.playerName.toLowerCase() === playerName.toLowerCase() && p.statType === statType
    );

    return match ? { line: match.line, isAvailable: true } : { line: null, isAvailable: false };
  }

  async fetchPlayerStats({ playerId, season }) {
    if (!playerId) return [];

    const yr = season || new Date().getFullYear();

    try {
      const { cacheGet, cacheSet } = require('../../../config/redis');
      const cacheKey = `playerstats:nfl:${playerId}:${yr}`;
      const cached = await cacheGet(cacheKey);
      if (cached?.length > 0) return cached;

      let stats = await this.statsClient.get('players/statistics', { id: playerId, season: yr });
      if (!stats?.length) {
        stats = await this.statsClient.get('players/statistics', { id: playerId, season: yr - 1 });
      }

      if (stats?.length) await cacheSet(cacheKey, stats, 6 * 60 * 60);
      logger.info(`✅ [NFL] ${stats?.length || 0} game records for player ${playerId}`);
      return stats || [];
    } catch (err) {
      logger.error('❌ [NFL] fetchPlayerStats failed', { playerId, error: err.message });
      return [];
    }
  }

  getRequiredStats() {
    return ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'pass_tds', 'rush_reception_yards'];
  }

  applyFormulas(rawStats, statType = 'passing_yards') {
    return applyNFLFormulas(rawStats, statType);
  }

  buildPrompt(params) {
    return buildNFLPrompt(params);
  }

  normalizeGame(rawGame) {
    const homeTeam = rawGame.home_team;
    const awayTeam = rawGame.away_team;
    const homeLogoUrl = getTeamLogoUrl('nfl', homeTeam) || getApiSportsLogoUrl('nfl', homeTeam);
    const awayLogoUrl = getTeamLogoUrl('nfl', awayTeam) || getApiSportsLogoUrl('nfl', awayTeam);

    return {
      sport: 'nfl',
      league: 'NFL',
      oddsEventId: rawGame.id,
      homeTeam: {
        name: homeTeam,
        abbreviation: getTeamAbbr('nfl', homeTeam),
        apiSportsId: getTeamId('nfl', homeTeam),
        logoUrl: homeLogoUrl,
        logo: homeLogoUrl,
      },
      awayTeam: {
        name: awayTeam,
        abbreviation: getTeamAbbr('nfl', awayTeam),
        apiSportsId: getTeamId('nfl', awayTeam),
        logoUrl: awayLogoUrl,
        logo: awayLogoUrl,
      },
      startTime: new Date(rawGame.commence_time),
      status: 'scheduled',
      venue: { name: rawGame.venue || null },
    };
  }

  normalizeProp(rawProp) {
    return {
      sport: 'nfl',
      playerName: rawProp.playerName,
      statType: rawProp.statType,
      line: rawProp.line,
      overOdds: rawProp.overOdds,
      underOdds: rawProp.underOdds,
      bookmaker: rawProp.bookmaker,
      oddsEventId: rawProp.oddsEventId,
      isAvailable: true,
      lastUpdatedAt: new Date(),
    };
  }

  _extractProps(eventData, oddsEventId) {
    const props = [];

    for (const bk of eventData?.bookmakers || []) {
      for (const market of bk.markets || []) {
        const statType = NFL_MARKET_MAP[market.key];
        if (!statType) continue;

        const byPlayer = {};
        for (const o of market.outcomes || []) {
          const pn = o.description;
          if (!pn) continue;
          if (!byPlayer[pn]) byPlayer[pn] = { playerName: pn, statType, bookmaker: bk.title, oddsEventId };
          if (o.name === 'Over') {
            byPlayer[pn].line = o.point;
            byPlayer[pn].overOdds = o.price;
          }
          if (o.name === 'Under') {
            byPlayer[pn].underOdds = o.price;
          }
        }

        for (const p of Object.values(byPlayer)) {
          if (p.line !== undefined && p.overOdds !== undefined) props.push(p);
        }
      }

      if (props.length > 0 && bk.title === 'DraftKings') break;
    }

    return props;
  }

  _trackQuota(headers) {
    const r = parseInt(headers?.['x-requests-remaining'], 10);
    if (!isNaN(r)) {
      const prevQuota = this.oddsApiQuotaRemaining;
      this.oddsApiQuotaRemaining = r;
      if (r <= this.QUOTA_STOP_THRESHOLD && prevQuota > this.QUOTA_STOP_THRESHOLD) {
        // Log only once when first crossing the threshold
        logger.error(`🚨 [NFL] Odds API quota CRITICAL: ${r}`);
      }
      else if (r <= 50) logger.warn(`⚠️  [NFL] Odds API quota LOW: ${r}`);
    }
  }

  _quotaSafe() {
    if (this.oddsApiQuotaRemaining <= this.QUOTA_STOP_THRESHOLD) {
      if (this.oddsApiQuotaRemaining > 0) {
        logger.warn('[NFL] Quota too low — skipping');
        this.oddsApiQuotaRemaining = 0;
      }
      return false;
    }
    return true;
  }
}

module.exports = NFLAdapter;

/**
 * MLBAdapter.js — MLB sport adapter
 *
 * DATA SOURCES:
 *  Props/Schedule → The Odds API Pro (baseball_mlb, DraftKings lines)
 *  Stats          → Official MLB Stats API (statsapi.mlb.com — free, no key)
 *  Logos          → ESPN CDN
 *
 * MLB prop markets (The Odds API Pro):
 *  batter_hits, batter_total_bases, pitcher_strikeouts,
 *  batter_rbis, batter_runs_scored
 *  (Home runs excluded — too noisy)
 *
 * Player stats resolved by name via MLBStatsClient (MLBAM IDs cached permanently).
 * Pitcher props identified by statType === 'pitcher_strikeouts'.
 */

const BaseAdapter     = require('../../shared/BaseAdapter');
const axios           = require('axios');
const logger          = require('../../../config/logger');
const { applyMLBFormulas, buildMLBPrompt } = require('./MLBFormulas');
const { getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');

// Valid MLB prop stat types — filter out HR (too noisy) and unknown cross-sport leakage
const VALID_MLB_STAT_TYPES = new Set(['hits','total_bases','pitcher_strikeouts','runs','rbis']);

// The Odds API market keys → internal stat types
const MLB_MARKET_MAP = {
  batter_hits:         'hits',
  batter_total_bases:  'total_bases',
  pitcher_strikeouts:  'pitcher_strikeouts',
  batter_rbis:         'rbis',
  batter_runs_scored:  'runs',
};

class MLBAdapter extends BaseAdapter {
  constructor() {
    super('mlb');

    this.oddsApiBase  = process.env.THE_ODDS_API_BASE_URL;
    this.oddsApiKey   = process.env.THE_ODDS_API_KEY;
    this.oddsSportKey = 'baseball_mlb';
    this.propMarkets  = Object.keys(MLB_MARKET_MAP);

    this.oddsApiQuotaRemaining = Infinity;
    this.QUOTA_STOP_THRESHOLD  = 10;
  }

  // ─── Schedule ──────────────────────────────────────────────────────────────

  async fetchSchedule() {
    try {
      logger.info('📅 [MLB] Fetching schedule...');
      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events`,
        { params: { apiKey: this.oddsApiKey }, timeout: 10000 }
      );
      this._trackQuota(response.headers);
      const games = response.data || [];
      logger.info(`✅ [MLB] ${games.length} games`);
      return games.map(g => this.normalizeGame(g));
    } catch (err) {
      logger.error('❌ [MLB] fetchSchedule failed', { error: err.message });
      throw err;
    }
  }

  // ─── Props ─────────────────────────────────────────────────────────────────

  async fetchProps(oddsEventId, { markets = null } = {}) {
    if (!this._quotaSafe()) return [];
    try {
      const marketsParam = markets
        ? (Array.isArray(markets) ? markets : [markets]).join(',')
        : this.propMarkets.join(',');

      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events/${oddsEventId}/odds`,
        {
          params: { apiKey: this.oddsApiKey, regions: 'us', markets: marketsParam, oddsFormat: 'american' },
          timeout: 10000,
        }
      );
      this._trackQuota(response.headers);
      const props = this._extractProps(response.data, oddsEventId);
      logger.info(`✅ [MLB] ${props.length} props for event ${oddsEventId}`);
      return props;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 422) {
        logger.error(`🔑 [MLB] Odds API ${status} — quota exhausted`);
        this.oddsApiQuotaRemaining = 0;
        return [];
      }
      logger.error('❌ [MLB] fetchProps failed', { oddsEventId, error: err.message });
      throw err;
    }
  }

  async fetchCurrentLine(oddsEventId, playerName, statType) {
    const marketKey = Object.entries(MLB_MARKET_MAP).find(([,v]) => v === statType)?.[0];
    if (!marketKey) return { line: null, isAvailable: false };
    const props = await this.fetchProps(oddsEventId, { markets: marketKey });
    const match = props.find(p => p.playerName.toLowerCase() === playerName.toLowerCase() && p.statType === statType);
    return match ? { line: match.line, isAvailable: true } : { line: null, isAvailable: false };
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Fetch player game log from official MLB Stats API (statsapi.mlb.com).
   *
   * FREE — no key required. Official MLB data.
   * Uses player NAME for lookup (no player ID needed from propWatcher).
   *
   * @param {Object} params
   * @param {string} params.playerName - Player name from The Odds API prop
   * @param {number} params.playerId   - Ignored (MLB uses MLBAM IDs resolved by name)
   * @param {string} params.season     - Season year e.g. "2025"
   * @param {boolean} params.isPitcher - true = fetch pitching stats
   */
  async fetchPlayerStats({ playerName, playerId, season, isPitcher = false }) {
    // MLB stats come from official MLB API — no API-Sports player ID needed
    const yr = season || String(new Date().getFullYear());

    if (!playerName) {
      logger.warn('[MLB] fetchPlayerStats called without playerName');
      return [];
    }

    try {
      const { cacheGet, cacheSet } = require('../../../config/redis');
      const cacheKey = `mlbstats:${playerName.toLowerCase().replace(/\s+/g,'_')}:${yr}:${isPitcher?'p':'b'}`;
      const cached   = await cacheGet(cacheKey);
      if (cached?.length > 0) return cached;

      const mlbClient = require('../../shared/MLBStatsClient');
      const stats = await mlbClient.getPlayerStats(playerName, isPitcher, parseInt(yr));

      if (stats?.length) {
        await cacheSet(cacheKey, stats, 4 * 60 * 60); // 4h cache
        logger.info(`✅ [MLB] ${stats.length} game records for "${playerName}"`);
      } else {
        logger.debug(`[MLB] No stats found for "${playerName}" (${yr})`);
      }

      return stats || [];
    } catch (err) {
      logger.error('❌ [MLB] fetchPlayerStats failed', { playerName, error: err.message });
      return [];
    }
  }

  // ─── Formulas (delegated to MLBFormulas.js) ───────────────────────────────

  getRequiredStats() { return ['hits','total_bases','pitcher_strikeouts','runs','rbis']; }

  applyFormulas(rawStats, statType = 'hits', context = {}) {
    return applyMLBFormulas(rawStats, statType, context);
  }

  buildPrompt(params) {
    return buildMLBPrompt(params);
  }

  // ─── Normalization ─────────────────────────────────────────────────────────

  normalizeGame(rawGame) {
    const homeTeam = rawGame.home_team;
    const awayTeam = rawGame.away_team;
    const homeLogoUrl = getTeamLogoUrl('mlb', homeTeam) || getApiSportsLogoUrl('mlb', homeTeam);
    const awayLogoUrl = getTeamLogoUrl('mlb', awayTeam) || getApiSportsLogoUrl('mlb', awayTeam);
    return {
      sport:       'mlb',
      league:      'MLB',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:        homeTeam,
        abbreviation: getTeamAbbr('mlb', homeTeam),
        apiSportsId:  getTeamId('mlb', homeTeam),
        logoUrl:      homeLogoUrl,
        logo:         homeLogoUrl,
      },
      awayTeam: {
        name:        awayTeam,
        abbreviation: getTeamAbbr('mlb', awayTeam),
        apiSportsId:  getTeamId('mlb', awayTeam),
        logoUrl:      awayLogoUrl,
        logo:         awayLogoUrl,
      },
      startTime: new Date(rawGame.commence_time),
      status:    'scheduled',
      venue:     { name: rawGame.venue || null },
    };
  }

  normalizeProp(rawProp) {
    return {
      sport:       'mlb',
      playerName:  rawProp.playerName,
      statType:    rawProp.statType,
      line:        rawProp.line,
      overOdds:    rawProp.overOdds,
      underOdds:   rawProp.underOdds,
      bookmaker:   rawProp.bookmaker,
      oddsEventId: rawProp.oddsEventId,
      isPitcher:   rawProp.statType === 'pitcher_strikeouts',
      isAvailable: true,
      lastUpdatedAt: new Date(),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  _extractProps(eventData, oddsEventId) {
    const props = [];
    for (const bk of eventData?.bookmakers || []) {
      for (const market of bk.markets || []) {
        const statType = MLB_MARKET_MAP[market.key];
        if (!statType || !VALID_MLB_STAT_TYPES.has(statType)) continue;

        const byPlayer = {};
        for (const o of market.outcomes || []) {
          const pn = o.description;
          if (!byPlayer[pn]) byPlayer[pn] = { playerName:pn, statType, bookmaker:bk.title, oddsEventId };
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

  _trackQuota(headers) {
    const r = parseInt(headers?.['x-requests-remaining'], 10);
    if (!isNaN(r)) {
      this.oddsApiQuotaRemaining = r;
      if (r <= this.QUOTA_STOP_THRESHOLD) logger.error(`🚨 [MLB] Odds API quota CRITICAL: ${r}`);
      else if (r <= 50) logger.warn(`⚠️  [MLB] Odds API quota LOW: ${r}`);
    }
  }

  _quotaSafe() {
    if (this.oddsApiQuotaRemaining <= this.QUOTA_STOP_THRESHOLD) {
      if (this.oddsApiQuotaRemaining > 0) {
        logger.warn(`[MLB] Quota too low — skipping`);
        this.oddsApiQuotaRemaining = 0;
      }
      return false;
    }
    return true;
  }
}

module.exports = MLBAdapter;
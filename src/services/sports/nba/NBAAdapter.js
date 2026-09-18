/**
 * NBAAdapter.js — NBA sport adapter (thin orchestration layer)
 *
 * This file handles ONLY:
 *  - HTTP calls to The Odds API (schedule + props)
 *  - HTTP calls to API-Sports v2 (player stats)
 *  - Normalization of raw API responses
 *
 * Formulas → NBAFormulas.js
 * Team IDs/logos → teamMaps.js
 * HTTP client → ApiSportsClient.js
 *
 * DATA SOURCES:
 *  Props/Schedule → The Odds API Pro (DraftKings lines)
 *  Stats          → API-Sports NBA v2 (game logs)
 *  Logos          → ESPN CDN (free, stable)
 */

const BaseAdapter    = require('../../shared/BaseAdapter');
const axios          = require('axios');
const logger         = require('../../../config/logger');
const ApiSportsClient = require('../../shared/ApiSportsClient');
const ESPNClient        = require('../../shared/ESPNClient');
const ESPNPlayerResolver = require('../../shared/ESPNPlayerResolver');
const { applyNBAFormulas, buildNBAPrompt } = require('./NBAFormulas');
const { getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');

// Feature flag — flip to 'false' to fall back to API-Sports NBA v2.
// Default 'true'; ESPN is free and covers all current seasons without
// paid-tier restrictions.
const USE_ESPN_STATS = String(process.env.USE_ESPN_STATS_NBA || 'true').toLowerCase() === 'true';

// If the current season has fewer than this many games logged, merge in
// the prior season so the FORM/EDGE windows aren't dominated by 1-2 games.
const MIN_GAMES_BEFORE_MERGE_NBA = 10;

class NBAAdapter extends BaseAdapter {
  constructor() {
    super('nba');

    // The Odds API — props and schedule
    this.oddsApiBase  = process.env.THE_ODDS_API_BASE_URL;
    this.oddsApiKey   = process.env.THE_ODDS_API_KEY;
    this.oddsSportKey = 'basketball_nba';
    this.propMarkets  = ['player_points','player_rebounds','player_assists','player_threes','player_points_assists'];

    // API-Sports NBA v2 — game logs
    this.statsClient = new ApiSportsClient('nba');

    // Quota guard
    this.oddsApiQuotaRemaining = Infinity;
    this.QUOTA_STOP_THRESHOLD  = 10;
  }

  // ─── Schedule ──────────────────────────────────────────────────────────────

  async fetchSchedule() {
    try {
      logger.info('📅 [NBA] Fetching schedule...');
      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events`,
        { params: { apiKey: this.oddsApiKey }, timeout: 10000 }
      );
      this._trackQuota(response.headers);
      const games = response.data || [];
      logger.info(`✅ [NBA] ${games.length} games`);
      return games.map(g => this.normalizeGame(g));
    } catch (err) {
      logger.error('❌ [NBA] fetchSchedule failed', { error: err.message });
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
        .filter(g => g?.completed === true && g?.id)
        .map(g => String(g.id));
    } catch (err) {
      logger.warn('⚠️ [NBA] fetchFinalEventIds failed', { error: err.message });
      return [];
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
      logger.info(`✅ [NBA] ${props.length} props for event ${oddsEventId}`);
      return props;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 422) {
        logger.error(`🔑 [NBA] Odds API ${status} — quota exhausted`);
        this.oddsApiQuotaRemaining = 0;
        return [];
      }
      logger.error('❌ [NBA] fetchProps failed', { oddsEventId, error: err.message });
      throw err;
    }
  }

  async fetchCurrentLine(oddsEventId, playerName, statType) {
    const marketKey = { points:'player_points', rebounds:'player_rebounds', assists:'player_assists', threes:'player_threes', points_assists:'player_points_assists' }[statType] || 'player_points';
    const props = await this.fetchProps(oddsEventId, { markets: marketKey });
    const match = props.find(p => p.playerName.toLowerCase() === playerName.toLowerCase() && p.statType === statType);
    return match ? { line: match.line, isAvailable: true } : { line: null, isAvailable: false };
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async fetchPlayerStats({ playerId, playerName, homeTeamName, awayTeamName, season }) {
    if (!season) {
      const now = new Date();
      const yr  = now.getFullYear();
      season = (now.getMonth() + 1) >= 10 ? yr : yr - 1;
    }

    if (USE_ESPN_STATS) {
      return this._fetchStatsFromESPN({ playerName, homeTeamName, awayTeamName, season });
    }

    // Legacy API-Sports path (kept for rollback).
    try {
      const { cacheGet, cacheSet } = require('../../../config/redis');
      const cacheKey = `playerstats:nba:${playerId}:${season}`;
      const cached   = await cacheGet(cacheKey);
      if (cached?.length > 0) return cached;

      let stats = await this.statsClient.get('players/statistics', { id: playerId, season });
      if (!stats?.length) {
        stats = await this.statsClient.get('players/statistics', { id: playerId, season: season - 1 });
      }

      if (stats?.length) await cacheSet(cacheKey, stats, 6 * 60 * 60);
      logger.info(`✅ [NBA] ${stats?.length || 0} game records for player ${playerId}`);
      return stats || [];
    } catch (err) {
      logger.error('❌ [NBA] fetchPlayerStats failed', { playerId, error: err.message });
      throw err;
    }
  }

  /**
   * ESPN-backed NBA stats path. Resolves the player to an ESPN athlete ID
   * via team roster lookup, then pulls their per-game log for the current
   * (and if empty, prior) season. Returns rows shaped for NBAFormulas.
   */
  async _fetchStatsFromESPN({ playerName, homeTeamName, awayTeamName, season }) {
    if (!playerName) {
      logger.warn('[NBA/ESPN] fetchPlayerStats called without playerName');
      return [];
    }

    const { cacheGet, cacheSet } = require('../../../config/redis');
    const cacheKey = `nba:espn-stats:v1:${playerName.toLowerCase()}:${season}`;
    const cached = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    try {
      const athleteId = await ESPNPlayerResolver.resolve({
        sportKey: 'nba',
        playerName,
        homeTeamName,
        awayTeamName,
      });

      if (!athleteId) {
        logger.debug(`[NBA/ESPN] Could not resolve athlete for "${playerName}"`);
        return [];
      }

      const fetchOne = async (yr) => {
        try {
          const raw = await ESPNClient.gamelog('nba', athleteId, yr);
          return this._parseESPNGamelog(raw);
        } catch (fetchErr) {
          logger.debug(`[NBA/ESPN] gamelog season ${yr} failed`, {
            athleteId, playerName, error: fetchErr.message,
          });
          return [];
        }
      };

      const currentRows = (await fetchOne(season)).map(r => ({ ...r, season }));
      let rows = currentRows;
      let usedSeasons = [season];

      if (currentRows.length < MIN_GAMES_BEFORE_MERGE_NBA) {
        const priorRows = (await fetchOne(season - 1)).map(r => ({ ...r, season: season - 1 }));
        if (priorRows.length > 0) {
          rows = [...priorRows, ...currentRows];
          usedSeasons = [season - 1, season];
        }
      }

      // Chronological sort — ESPN returns newest-first per season, so a
      // raw concat is not date-ordered. Formula slices are slice(-N) for
      // the most recent N, which only works if rows are oldest→newest.
      rows = rows.slice().sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : 0;
        const tb = b.date ? new Date(b.date).getTime() : 0;
        return ta - tb;
      });

      if (rows.length > 0) {
        await cacheSet(cacheKey, rows, 6 * 60 * 60);
        logger.info(
          `✅ [NBA/ESPN] ${rows.length} game records for ${playerName} ` +
          `(season${usedSeasons.length > 1 ? 's' : ''} ${usedSeasons.join('+')}` +
          `, current=${currentRows.length})`
        );
      } else {
        logger.warn(`⚠️  [NBA/ESPN] No stats for ${playerName} across ${season} and ${season - 1}`);
      }
      return rows;
    } catch (err) {
      logger.error(`❌ [NBA/ESPN] fetchPlayerStats failed for "${playerName}"`, { error: err.message });
      return [];
    }
  }

  /**
   * Parse ESPN's NBA gamelog into a flat per-game array with field names
   * NBAFormulas already knows how to read (points, totReb, assists, tpm,
   * fgm, fga, ftm, fta, tpa, turnovers, min, plusMinus).
   */
  _parseESPNGamelog(raw) {
    if (!raw) return [];
    const names = Array.isArray(raw.names) ? raw.names : [];

    const rows = [];
    // Path 1: seasonTypes → categories → events with inline stats
    const seasonTypes = Array.isArray(raw.seasonTypes) ? raw.seasonTypes : [];
    for (const st of seasonTypes) {
      const categories = Array.isArray(st?.categories) ? st.categories : [];
      for (const cat of categories) {
        if (cat?.type && cat.type !== 'event') continue;
        const events = Array.isArray(cat?.events) ? cat.events : [];
        for (const event of events) {
          const row = this._eventToRowNBA(event, names);
          if (row) rows.push(row);
        }
      }
    }
    if (rows.length > 0) return rows;

    // Path 2: flat events map
    const eventsMap = raw.events && typeof raw.events === 'object' && !Array.isArray(raw.events)
      ? raw.events
      : null;
    if (eventsMap) {
      for (const event of Object.values(eventsMap)) {
        const row = this._eventToRowNBA(event, names);
        if (row) rows.push(row);
      }
    }
    return rows;
  }

  _eventToRowNBA(event, names) {
    if (!event) return null;
    const statValues = Array.isArray(event.stats) ? event.stats : [];
    if (statValues.length === 0) return null;

    // ESPN NBA gamelog stat name mapping (labels seen in the wild):
    //   MIN, FG, FG%, 3PT, 3P%, FT, FT%, OR, DR, REB, AST, STL, BLK, TO, PF, +/-, PTS
    // FG comes as a "MADE-ATT" string like "8-15"; same for 3PT and FT.
    const raw = {};
    for (let i = 0; i < names.length && i < statValues.length; i += 1) {
      raw[names[i]] = statValues[i];
    }

    const parseMadeAtt = (s) => {
      if (typeof s !== 'string') return { made: 0, att: 0 };
      const [m, a] = s.split('-').map(x => Number(x));
      return { made: Number.isFinite(m) ? m : 0, att: Number.isFinite(a) ? a : 0 };
    };
    const num = (v) => {
      const x = Number(String(v ?? '').replace(/,/g, ''));
      return Number.isFinite(x) ? x : 0;
    };

    const fg  = parseMadeAtt(raw.FG);
    const tpt = parseMadeAtt(raw['3PT']);
    const ft  = parseMadeAtt(raw.FT);

    return {
      eventId:  event.eventId || event.id || null,
      date:     event.gameDate || event.date || null,
      opponent: event.opponent?.abbreviation || event.opponent?.displayName || null,
      homeAway: event.homeAwaySymbol || (event.atVs === '@' || event.atVs === 'at' ? 'away' : 'home'),

      // Fields matching NBAFormulas sum()
      points:     num(raw.PTS),
      fgm:        fg.made,
      fga:        fg.att,
      ftm:        ft.made,
      fta:        ft.att,
      tpm:        tpt.made,
      tpa:        tpt.att,
      totReb:     num(raw.REB),
      offReb:     num(raw.OR),
      defReb:     num(raw.DR),
      assists:    num(raw.AST),
      turnovers:  num(raw.TO),
      steals:     num(raw.STL),
      blocks:     num(raw.BLK),
      min:        raw.MIN || '0',
      plusMinus:  raw['+/-'] ?? 0,
    };
  }

  // ─── Formulas (delegated to NBAFormulas.js) ───────────────────────────────

  getRequiredStats() { return ['points','rebounds','assists','threes']; }

  applyFormulas(rawStats, statType = 'points') {
    return applyNBAFormulas(rawStats, statType);
  }

  buildPrompt(params) {
    return buildNBAPrompt(params);
  }

  // ─── Normalization ─────────────────────────────────────────────────────────

  normalizeGame(rawGame) {
    const homeTeam = rawGame.home_team;
    const awayTeam = rawGame.away_team;
    return {
      sport:       'nba',
      league:      'NBA',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:        homeTeam,
        abbreviation: getTeamAbbr('nba', homeTeam),
        apiSportsId:  getTeamId('nba', homeTeam),
        logoUrl:      getTeamLogoUrl('nba', homeTeam) || getApiSportsLogoUrl('nba', homeTeam),
      },
      awayTeam: {
        name:        awayTeam,
        abbreviation: getTeamAbbr('nba', awayTeam),
        apiSportsId:  getTeamId('nba', awayTeam),
        logoUrl:      getTeamLogoUrl('nba', awayTeam) || getApiSportsLogoUrl('nba', awayTeam),
      },
      startTime: new Date(rawGame.commence_time),
      status: 'scheduled',
    };
  }

  normalizeProp(rawProp) {
    return {
      sport:        'nba',
      playerName:   rawProp.playerName,
      statType:     rawProp.statType,
      line:         rawProp.line,
      overOdds:     rawProp.overOdds,
      underOdds:    rawProp.underOdds,
      bookmaker:    rawProp.bookmaker,
      oddsEventId:  rawProp.oddsEventId,
      isAvailable:  true,
      lastUpdatedAt: new Date(),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  _extractProps(eventData, oddsEventId) {
    const props = [];
    const marketMap = { player_points:'points', player_rebounds:'rebounds', player_assists:'assists', player_threes:'threes', player_points_assists:'points_assists' };

    for (const bk of eventData?.bookmakers || []) {
      for (const market of bk.markets || []) {
        const statType = marketMap[market.key];
        if (!statType) continue;

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
      const prevQuota = this.oddsApiQuotaRemaining;
      this.oddsApiQuotaRemaining = r;
      if (r <= this.QUOTA_STOP_THRESHOLD && prevQuota > this.QUOTA_STOP_THRESHOLD) {
        // Log only once when first crossing the threshold
        logger.error(`🚨 [NBA] Odds API quota CRITICAL: ${r}`);
      }
      else if (r <= 50) logger.warn(`⚠️  [NBA] Odds API quota LOW: ${r}`);
    }
  }

  _quotaSafe() {
    if (this.oddsApiQuotaRemaining <= this.QUOTA_STOP_THRESHOLD) {
      if (this.oddsApiQuotaRemaining > 0) {
        logger.warn(`[NBA] Quota too low — skipping`);
        this.oddsApiQuotaRemaining = 0;
      }
      return false;
    }
    return true;
  }
}

module.exports = NBAAdapter;


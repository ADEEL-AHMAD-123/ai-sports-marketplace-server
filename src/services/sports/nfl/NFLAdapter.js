/**
 * NFLAdapter.js — NFL sport adapter
 *
 * DATA SOURCES:
 *  Props/Schedule → The Odds API (americanfootball_nfl)
 *  Stats          → ESPN public API (per-game gamelog) — DEFAULT
 *                   Legacy API-Sports path still callable via
 *                   USE_ESPN_STATS_NFL=false env override
 *
 * WHY THE ESPN PATH IS DEFAULT:
 *   API-Sports' `players/statistics` endpoint returns season aggregates
 *   (career-by-team totals) but our downstream scoring code (StrategyService,
 *   NFLFormulas) treats the response as an array of PER-GAME rows. That
 *   mismatch produced misleading confidence + HC/BV tags for NFL.
 *   ESPN's `/athletes/{id}/gamelog` returns real per-game rows with the
 *   fields our formulas already know how to read (passingYards, rushingYards,
 *   receivingYards, receptions, passingTouchdowns).
 */

const BaseAdapter = require('../../shared/BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const ApiSportsClient = require('../../shared/ApiSportsClient');
const ESPNClient      = require('../../shared/ESPNClient');
const ESPNPlayerResolver = require('../../shared/ESPNPlayerResolver');
const { applyNFLFormulas, buildNFLPrompt } = require('./NFLFormulas');
const { nflSeasonYear } = require('./nflSeason');
const { getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl } = require('../../shared/teamMaps');

// Feature flag — default TRUE (ESPN). Set USE_ESPN_STATS_NFL=false to
// force the legacy API-Sports path (useful if ESPN has an outage).
const USE_ESPN_STATS = String(process.env.USE_ESPN_STATS_NFL ?? 'true').toLowerCase() !== 'false';

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
    const scored = await this.fetchFinalScores({ daysFrom });
    return scored.filter((g) => g.completed).map((g) => g.eventId);
  }

  /**
   * Fetch recent games WITH scores from The Odds API /scores endpoint.
   *
   * Returns one entry per event:
   *   { eventId, completed, homeTeam, awayTeam, homeScore, awayScore }
   *
   * Scores are null until the provider posts them. Used by postGameSync to
   * both detect finalized games and persist results into TeamGameResult.
   */
  async fetchFinalScores({ daysFrom = 3 } = {}) {
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
        .filter((g) => g?.id)
        .map((g) => {
          // /scores returns `scores: [{ name, score }]` (score is a string),
          // or null before the game has a posted score.
          const scoreRows = Array.isArray(g.scores) ? g.scores : [];
          const scoreFor = (teamName) => {
            if (!teamName) return null;
            const row = scoreRows.find((s) => s?.name === teamName);
            const n = row ? Number(row.score) : NaN;
            return Number.isFinite(n) ? n : null;
          };
          return {
            eventId:   String(g.id),
            completed: g.completed === true,
            homeTeam:  g.home_team || null,
            awayTeam:  g.away_team || null,
            homeScore: scoreFor(g.home_team),
            awayScore: scoreFor(g.away_team),
          };
        });
    } catch (err) {
      logger.warn('⚠️ [NFL] fetchFinalScores failed', { error: err.message });
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

  async fetchPlayerStats({ playerId, playerName, homeTeamName, awayTeamName, season } = {}) {
    // NFL seasons are start-year based — using the raw calendar year would
    // request a not-yet-started season for every Jan–Jul game and burn an
    // API call on the empty result before the yr-1 fallback corrects it.
    const yr = season || nflSeasonYear();

    // ── ESPN path (default) ────────────────────────────────────────────
    if (USE_ESPN_STATS) {
      return this._fetchStatsFromESPN({ playerName, homeTeamName, awayTeamName, season: yr });
    }

    // ── Legacy API-Sports path (behind USE_ESPN_STATS_NFL=false) ───────
    if (!playerId) return [];

    try {
      const { cacheGet, cacheSet } = require('../../../config/redis');
      const cacheKey = `playerstats:nfl:${playerId}:${yr}`;
      const cached = await cacheGet(cacheKey);
      if (cached?.length > 0) return cached;

      // Multi-year fallback chain. API-Sports FREE tier for American
      // Football only allows seasons 2022-2024; paid tiers unlock current
      // + prior. So a plan mismatch (current-year blocked) leaves us
      // walking back until we hit an allowed season. Two-year fallback
      // keeps insights non-empty even on the free plan, at the cost of
      // reasoning about aged data. The `usedSeason` log line makes it
      // obvious in the log which year the data actually came from — if
      // you're consistently seeing yr-2 or older, you need to upgrade
      // the API-Sports American Football plan.
      const seasonsToTry = [yr, yr - 1, yr - 2];
      let stats = [];
      let usedSeason = null;
      for (const trySeason of seasonsToTry) {
        try {
          const result = await this.statsClient.get('players/statistics', { id: playerId, season: trySeason });
          if (result?.length) {
            stats = result;
            usedSeason = trySeason;
            break;
          }
        } catch (fetchErr) {
          logger.debug(`[NFL] fetchPlayerStats season ${trySeason} threw`, {
            playerId, error: fetchErr.message,
          });
          // continue to next season
        }
      }

      if (stats?.length) {
        await cacheSet(cacheKey, stats, 6 * 60 * 60);
        // Warn (not info) when we had to fall back — this is a plan-tier
        // signal worth surfacing in the log stream.
        if (usedSeason && usedSeason < yr) {
          logger.warn(
            `⚠️  [NFL] Using ${usedSeason} stats for player ${playerId} — current-season data unavailable ` +
            `(likely API-Sports plan-tier limit; upgrade to unlock ${yr} data).`
          );
        } else {
          logger.info(`✅ [NFL] ${stats.length} game records for player ${playerId} (season ${usedSeason})`);
        }
      } else {
        logger.warn(`⚠️  [NFL] No stats found for player ${playerId} across ${seasonsToTry.join(', ')}`);
      }
      return stats || [];
    } catch (err) {
      logger.error('❌ [NFL] fetchPlayerStats failed', { playerId, error: err.message });
      return [];
    }
  }

  /**
   * ESPN-backed stats path. Resolves the player to an ESPN athlete ID via
   * team roster lookup, then pulls their per-game log for the current
   * (and if empty, prior) season. Returns rows in a shape NFLFormulas
   * can consume directly (passingYards, rushingYards, receivingYards,
   * receptions, passingTouchdowns as top-level fields).
   */
  async _fetchStatsFromESPN({ playerName, homeTeamName, awayTeamName, season }) {
    if (!playerName) {
      logger.warn('[NFL/ESPN] fetchPlayerStats called without playerName');
      return [];
    }

    const { cacheGet, cacheSet } = require('../../../config/redis');
    const cacheKey = `nfl:espn-stats:${playerName.toLowerCase()}:${season}`;
    const cached = await cacheGet(cacheKey);
    if (cached?.length > 0) return cached;

    try {
      const athleteId = await ESPNPlayerResolver.resolve({
        sportKey: 'nfl',
        playerName,
        homeTeamName,
        awayTeamName,
      });

      if (!athleteId) {
        logger.warn(`[NFL/ESPN] Could not resolve athlete ID for "${playerName}" (${awayTeamName} @ ${homeTeamName})`);
        return [];
      }

      // Try current season first, fall back to prior season if empty
      // (early-week-1 games have zero regular-season stats).
      const seasonsToTry = [season, season - 1];
      let rows = [];
      let usedSeason = null;
      for (const trySeason of seasonsToTry) {
        try {
          const raw = await ESPNClient.gamelog('nfl', athleteId, trySeason);
          const parsed = this._parseESPNGamelog(raw);
          if (parsed.length > 0) { rows = parsed; usedSeason = trySeason; break; }
        } catch (fetchErr) {
          logger.debug(`[NFL/ESPN] gamelog season ${trySeason} failed`, {
            athleteId, playerName, error: fetchErr.message,
          });
        }
      }

      if (rows.length > 0) {
        // ESPN game logs are stable once a game is finalized — cache for
        // 6h during active play, longer would be fine for finalized games.
        await cacheSet(cacheKey, rows, 6 * 60 * 60);
        if (usedSeason && usedSeason < season) {
          logger.warn(`⚠️  [NFL/ESPN] Using ${usedSeason} log for ${playerName} — ${season} empty`);
        } else {
          logger.info(`✅ [NFL/ESPN] ${rows.length} game records for ${playerName} (season ${usedSeason})`);
        }
      } else {
        logger.warn(`⚠️  [NFL/ESPN] No stats for ${playerName} across ${seasonsToTry.join(', ')}`);
      }
      return rows;
    } catch (err) {
      logger.error(`❌ [NFL/ESPN] fetchPlayerStats failed for "${playerName}"`, { error: err.message });
      return [];
    }
  }

  /**
   * Parse ESPN's gamelog response into a flat per-game array with the
   * field names NFLFormulas.pick already knows how to read.
   *
   * ESPN returns one of TWO shapes depending on the athlete/season:
   *
   *   Shape A (older / regular-season centric):
   *     {
   *       names: ["passingYards", "rushingYards", ...],
   *       seasonTypes: [{
   *         displayName: "2024 Regular Season",
   *         categories: [{
   *           type: "event",
   *           events: [{ eventId, week, gameDate, stats: ["263", "0", ...] }]
   *         }]
   *       }]
   *     }
   *
   *   Shape B (newer / current NFL):
   *     {
   *       names: [...],
   *       events: {
   *         "401671889": { id, week, gameDate, opponent, stats: [...] },
   *         "401671665": { ... }
   *       },
   *       seasonTypes: [{ categories: [{ events: [{ eventId, stats: [...] }] }] }]
   *     }
   *
   * In shape B, the `events` map holds metadata and the seasonTypes hold
   * the actual stats — sometimes the stats live inline in the events map,
   * sometimes in a separate categories→events array that references by ID.
   * We handle both, then log if we saw neither so future debugging is easy.
   *
   * The `stats` array on each event is parallel to the top-level `names`
   * array — zip them to recover named fields.
   */
  _parseESPNGamelog(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const names = Array.isArray(raw.names) ? raw.names : [];
    if (!names.length) {
      logger.warn('[NFL/ESPN] gamelog response missing "names" — cannot parse', {
        topKeys: Object.keys(raw).slice(0, 20),
      });
      return [];
    }

    const rows = [];

    // Path 1: seasonTypes → categories → events with inline stats
    const seasonTypes = Array.isArray(raw.seasonTypes) ? raw.seasonTypes : [];
    for (const st of seasonTypes) {
      const categories = Array.isArray(st?.categories) ? st.categories : [];
      for (const cat of categories) {
        if (cat?.type && cat.type !== 'event') continue;
        const events = Array.isArray(cat?.events) ? cat.events : [];
        for (const event of events) {
          const row = this._eventToRow(event, names);
          if (row) rows.push(row);
        }
      }
    }
    if (rows.length > 0) return rows;

    // Path 2: flat events map with inline stats
    const eventsMap = raw.events && typeof raw.events === 'object' && !Array.isArray(raw.events)
      ? raw.events
      : null;
    if (eventsMap) {
      for (const event of Object.values(eventsMap)) {
        const row = this._eventToRow(event, names);
        if (row) rows.push(row);
      }
    }
    if (rows.length > 0) return rows;

    // Nothing matched — surface response structure so we can adapt.
    logger.warn('[NFL/ESPN] gamelog structure unrecognized — no rows parsed', {
      namesCount: names.length,
      hasSeasonTypes: Array.isArray(raw.seasonTypes),
      seasonTypesCount: (raw.seasonTypes || []).length,
      hasEventsMap: !!eventsMap,
      eventsMapCount: eventsMap ? Object.keys(eventsMap).length : 0,
      topKeys: Object.keys(raw).slice(0, 20),
    });
    return [];
  }

  /**
   * Zip one ESPN event object into a named-field row. Returns null when
   * the event lacks a stats array (empty games, byes, upcoming fixtures).
   */
  _eventToRow(event, names) {
    if (!event) return null;
    const statValues = Array.isArray(event.stats) ? event.stats : [];
    if (statValues.length === 0) return null;

    const row = {
      eventId:  event.eventId || event.id || null,
      week:     event.week || null,
      date:     event.gameDate || event.date || null,
      opponent: event.opponent?.abbreviation || event.opponent?.displayName || null,
      homeAway: event.homeAwaySymbol || (event.atVs === '@' || event.atVs === 'at' ? 'away' : 'home'),
    };
    for (let i = 0; i < names.length && i < statValues.length; i += 1) {
      const key = names[i];
      const value = statValues[i];
      // Values are often strings like "263", "6.5" — coerce numeric,
      // fall through to raw for non-numeric fields.
      const num = Number(String(value).replace(/,/g, ''));
      row[key] = Number.isFinite(num) ? num : value;
    }
    return row;
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

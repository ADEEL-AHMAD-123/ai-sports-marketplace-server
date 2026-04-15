/**
 * NBAAdapter.js — NBA-specific sport adapter
 *
 * Handles all NBA data operations:
 *  - Schedule fetching (The Odds API)
 *  - Player props (The Odds API)
 *  - Player stats (API-Sports Basketball)
 *  - Advanced formula calculation (TS%, USG%, eFG%)
 *  - AI prompt building with betting context
 *
 * DATA SOURCES (NBA — finalized in Phase 1):
 *  Odds  → The Odds API  (https://the-odds-api.com)
 *  Stats → API-Sports NBA v2 (https://v2.nba.api-sports.io)
 *
 * GLOSSARY (basketball betting terms):
 *  TS%  = True Shooting % — measures scoring efficiency including 3s and FTs
 *         Formula: Points / (2 * (FGA + 0.44 * FTA))
 *  eFG% = Effective Field Goal % — adjusts for 3-pointers being worth more
 *         Formula: (FGM + 0.5 * 3PM) / FGA
 *  USG% = Usage Rate — % of team plays that end with this player while on court
 *         Formula: (FGA + 0.44*FTA + TOV) / TeamPlays * 100
 *  FGA  = Field Goal Attempts
 *  FGM  = Field Goals Made
 *  FTA  = Free Throw Attempts
 *  3PM  = 3-Pointers Made
 *  TOV  = Turnovers
 *  PTS  = Points
 *  REB  = Rebounds (total = offensive + defensive)
 *  AST  = Assists
 *  MIN  = Minutes played
 */

const BaseAdapter = require('../BaseAdapter');
const axios  = require('axios');
const logger = require('../../../config/logger');
const { FORM_WINDOW, EDGE_WINDOW, BASELINE_WINDOW, MIN_GAMES_REQUIRED } = require('../../../config/constants');

class NBAAdapter extends BaseAdapter {
  constructor() {
    super('nba');

    // ── The Odds API config ─────────────────────────────────────────────────
    this.oddsApiBase = process.env.THE_ODDS_API_BASE_URL;
    this.oddsApiKey = process.env.THE_ODDS_API_KEY;

    // The Odds API sport key for NBA
    // Full list: https://the-odds-api.com/sports-odds-data/sports-apis.html
    this.oddsSportKey = 'basketball_nba';

    // Markets to fetch for player props
    // 'player_points' = over/under on player's total points
    // 'player_rebounds' = over/under on player's total rebounds
    // 'player_assists' = over/under on player's total assists
    // 'player_threes' = over/under on player's 3-pointers made
    this.propMarkets = [
      'player_points',
      'player_rebounds',
      'player_assists',
      'player_threes',
    ];

    // ── NBA API config ───────────────────────────────────────────────────────
    // NBA integrations must use the dedicated API_NBA_* variables only.
    this.statsApiBase = process.env.API_NBA_BASE_URL || 'https://v2.nba.api-sports.io';
    this.statsApiKey  = process.env.API_NBA_KEY;

    // NBA league ID in API-Sports (12 = NBA)
    this.apiSportsLeagueId = 12;
  }

  // ─── Schedule Fetching ─────────────────────────────────────────────────────

  /**
   * Fetch today's NBA schedule from The Odds API.
   * Returns upcoming games with home/away teams and start times.
   *
   * @returns {Promise<Array>} Array of normalized game objects
   */
  async fetchSchedule() {
    try {
      logger.info('📅 [NBA] Fetching schedule from The Odds API...');

      const response = await axios.get(`${this.oddsApiBase}/sports/${this.oddsSportKey}/events`, {
        params: { apiKey: this.oddsApiKey },
        timeout: 10000,
      });

      const games = response.data || [];
      logger.info(`✅ [NBA] Fetched ${games.length} games from schedule`);

      // Log remaining API quota (The Odds API has a monthly quota)
      if (response.headers['x-requests-remaining']) {
        logger.info(`📊 [NBA] Odds API quota remaining: ${response.headers['x-requests-remaining']}`);
      }

      return games.map((game) => this.normalizeGame(game));
    } catch (error) {
      logger.error('❌ [NBA] fetchSchedule failed', {
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Fetch player props for a specific NBA game from The Odds API.
   *
   * @param {string} oddsEventId - The Odds API event ID
   * @returns {Promise<Array>} Array of normalized prop objects
   */
  async fetchProps(oddsEventId) {
    try {
      logger.info(`📊 [NBA] Fetching props for event: ${oddsEventId}`);

      const response = await axios.get(
        `${this.oddsApiBase}/sports/${this.oddsSportKey}/events/${oddsEventId}/odds`,
        {
          params: {
            apiKey: this.oddsApiKey,
            // regions is REQUIRED by The Odds API — without it bookmakers array is empty
            regions: 'us',
            // Fetch multiple prop markets in one call (comma-separated)
            markets: this.propMarkets.join(','),
            // American odds format (-110, +110 style)
            oddsFormat: 'american',
            // Don't filter by bookmaker — let API return all available
            // (filtering too early can cause empty results if those books don't have the market)
          },
          timeout: 10000,
        }
      );

      const eventData = response.data;
      if (!eventData) return [];

      // ── Debug: log what came back so we can diagnose empty props ──────────
      const bookmakerCount = eventData.bookmakers?.length || 0;
      const firstMarkets   = eventData.bookmakers?.[0]?.markets?.map(m => m.key) || [];
      logger.info(`✅ [NBA] Fetched props for event: ${oddsEventId}`, {
        bookmakers: bookmakerCount,
        firstBookmaker: eventData.bookmakers?.[0]?.title,
        markets: firstMarkets,
        rawOutcomeSample: eventData.bookmakers?.[0]?.markets?.[0]?.outcomes?.slice(0, 2),
      });

      if (bookmakerCount === 0) {
        logger.warn(`⚠️  [NBA] No bookmakers returned for event ${oddsEventId} — check API plan supports player props`);
      }

      // Log remaining API quota
      if (response.headers['x-requests-remaining']) {
        logger.debug(`📊 [NBA] Odds API quota after props fetch: ${response.headers['x-requests-remaining']}`);
      }

      return this._extractPropsFromOddsResponse(eventData, oddsEventId);
    } catch (error) {
      logger.error('❌ [NBA] fetchProps failed', {
        oddsEventId,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Fetch current betting line for a specific prop (pre-flight check).
   * Bypasses cache — always fetches fresh from The Odds API.
   *
   * @param {string} oddsEventId
   * @param {string} playerName
   * @param {string} statType - e.g., 'points', 'rebounds'
   * @returns {Promise<{ line: number|null, isAvailable: boolean }>}
   */
  async fetchCurrentLine(oddsEventId, playerName, statType) {
    try {
      const props = await this.fetchProps(oddsEventId);

      // Find the specific prop for this player and stat
      const matchingProp = props.find(
        (p) =>
          p.playerName.toLowerCase() === playerName.toLowerCase() &&
          p.statType === statType.toLowerCase()
      );

      if (!matchingProp) {
        logger.warn(`⚠️  [NBA] Pre-flight: prop not found`, { playerName, statType, oddsEventId });
        return { line: null, isAvailable: false };
      }

      return { line: matchingProp.line, isAvailable: true };
    } catch (error) {
      logger.error('❌ [NBA] fetchCurrentLine failed', { error: error.message });
      throw error;
    }
  }

  /**
    * Fetch player statistics from API-Sports NBA v2.
   * Returns season averages + recent games for the player.
   *
   * @param {Object} params
   * @param {number} params.playerId - API-Sports player ID
    * @param {number|string} params.season - Season start year (e.g., 2024)
   * @returns {Promise<Object>} Raw player stats
   */
  async fetchPlayerStats({ playerId, season }) {
    // Default to current season start year dynamically.
    // NBA v2 expects an integer season year (e.g. 2024), not "2024-2025".
    if (!season) {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1; // 1-indexed
      // NBA 2025-2026 season → season param = 2025
      // If before October, we're in the previous season's start year.
      season = month >= 10 ? year : year - 1;
    }
    try {
      logger.info(`📈 [NBA] Fetching player stats`, { playerId, season });

      // ── Redis cache check ────────────────────────────────────────────────
      // Player game logs don't change during the day (games are played at night)
      // Cache for 6 hours — avoids duplicate API calls from PropWatcher + InsightService
      const { cacheGet, cacheSet } = require('../../../config/redis');
      const cacheKey = `playerstats:nba:${playerId}:${season}`;
      const STATS_TTL = 6 * 60 * 60; // 6 hours in seconds

      const cached = await cacheGet(cacheKey);
      if (cached && cached.length > 0) {
        logger.info(`⚡ [NBA] Player stats cache HIT for player ${playerId}: ${cached.length} records`);
        return cached;
      }

      // ── Fetch from API-Sports NBA v2 ─────────────────────────────────────
      const fetchStats = async (s) => {
        const res = await axios.get(`${this.statsApiBase}/players/statistics`, {
          headers: { 'x-apisports-key': this.statsApiKey },
          params:  { id: playerId, season: s },
          timeout: 10000,
        });
        return res.data?.response || [];
      };

      let stats = await fetchStats(season);

      // Free plan fallback to previous season
      if (stats.length === 0) {
        const seasonYear = parseInt(season, 10);
        const prevSeason = seasonYear - 1;
        logger.info(`[NBA] No stats for ${season}, trying previous season ${prevSeason}`);
        stats = await fetchStats(prevSeason);
        if (stats.length > 0) {
          logger.info(`[NBA] Using previous season ${prevSeason} for player ${playerId}`);
        }
      }

      // Cache result — only if we got data
      if (stats.length > 0) {
        await cacheSet(cacheKey, stats, STATS_TTL);
      }

      logger.info(`✅ [NBA] Fetched stats for player ${playerId}: ${stats.length} game records`, {
        season,
        resultsTotal: stats.length,
      });

      return stats;
    } catch (error) {
      logger.error('❌ [NBA] fetchPlayerStats failed', {
        playerId,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  // ─── Formula Engine ────────────────────────────────────────────────────────

  /**
   * Return the stat types this adapter processes.
   * Used for validation and documentation.
   */
  getRequiredStats() {
    return ['points', 'rebounds', 'assists', 'threes'];
  }

  /**
   * Apply NBA-specific advanced formulas to raw player stats.
   *
   * Takes raw game log stats and computes:
   *  - TS%  (True Shooting %) — overall scoring efficiency
   *  - eFG% (Effective FG %) — FG efficiency with 3-point adjustment
   *  - USG% (Usage Rate)     — how involved the player is offensively
   *  - Recent averages       — rolling averages for the stat being bet on
   *
   * @param {Array} rawStats     - Array of game log objects from API-Sports
   * @param {string} statType    - The stat to focus the analysis on
   * @returns {Object} Processed stats with advanced metrics
   */
  /**
   * Parse "MM:SS" string (e.g. "28:14") into decimal minutes (28.23)
   * parseFloat("28:14") would give 28 — wrong. This gives 28.23.
   */
  _parseMinutes(minStr) {
    if (!minStr) return 0;
    const parts = String(minStr).split(':');
    if (parts.length === 2) {
      return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
    }
    return parseFloat(minStr) || 0;
  }

  applyFormulas(rawStats, statType = 'points') {
    if (!rawStats || rawStats.length === 0) {
      logger.warn('[NBA] applyFormulas: no raw stats provided');
      return {};
    }

    // ── Three-window stat model ──────────────────────────────────────────────
    //
    // FORM_WINDOW (5):     confidence score + sparkline — "is player hot RIGHT NOW?"
    // EDGE_WINDOW (10):    edge % + focusStatAvg — "reliable recent average"
    // BASELINE_WINDOW (30): TS%/eFG%/USG% + AI context — "what book's line reflects"
    //
    // rawStats is ordered oldest→newest by API. slice(-N) = last N games played.
    const formGames     = rawStats.slice(-FORM_WINDOW);      // last 5  → hot/cold signal
    const edgeGames     = rawStats.slice(-EDGE_WINDOW);      // last 10 → edge calculation
    const baselineGames = rawStats.slice(-BASELINE_WINDOW);  // last 30 → efficiency + AI
    const totalGames    = formGames.length;

    const sumStats = (games) => games.reduce(
      (acc, game) => {
        acc.points    += game.points                     || 0;
        acc.fgm       += game.field_goals?.total         || 0;
        acc.fga       += game.field_goals?.attempts      || 0;
        acc.ftm       += game.free_throws?.total         || 0;
        acc.fta       += game.free_throws?.attempts      || 0;
        acc.tpm       += game.threepoint_goals?.total    || 0;
        acc.tpa       += game.threepoint_goals?.attempts || 0;
        acc.rebounds  += game.rebounds?.total            || 0;
        acc.assists   += game.assists                    || 0;
        acc.turnovers += game.turnovers                  || 0;
        acc.minutes   += this._parseMinutes(game.min);
        return acc;
      },
      { points: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, tpa: 0, rebounds: 0, assists: 0, turnovers: 0, minutes: 0 }
    );

    const formTotals     = sumStats(formGames);      // last 5  — form signal
    const edgeTotals     = sumStats(edgeGames);      // last 10 — edge calculation
    const baselineTotals = sumStats(baselineGames);  // last 30 — baseline + efficiency

    // DEBUG — log raw field values from the last game to verify API field names
    // Remove this after confirming data is correct
    const lastGame = rawStats[rawStats.length - 1];
    if (lastGame) {
      logger.debug('[NBA] applyFormulas field check (last game raw)', {
        statType,
        points:    lastGame.points,
        assists:   lastGame.assists,      // should be flat number e.g. 7
        rebounds:  lastGame.rebounds,     // should be nested { total, offensive, defensive }
        fga:       lastGame.field_goals?.attempts,
        fgm:       lastGame.field_goals?.total,
        fta:       lastGame.free_throws?.attempts,
        tpm:       lastGame.threepoint_goals?.total,
        min:       lastGame.min,
        turnovers: lastGame.turnovers,
        // Show if any unexpected nesting
        rebTotal:  lastGame.rebounds?.total,
        rawKeys:   Object.keys(lastGame).join(', '),
      });
    }

    // recentGames = form window (5) — used for confidence hit-rate calculation
    const recentGames = formGames;
    // totals = edge window (10) — used for avgPoints/rebounds etc and efficiency metrics
    const totals      = edgeTotals;

    // ── Compute averages per window ──────────────────────────────────────────
    const avgOf = (val, n) => (n > 0 ? parseFloat((val / n).toFixed(1)) : 0);

    // FORM averages (last 5) — hot/cold signal, shown as sparkline in modal
    const formCount   = formGames.length || 1;
    const formPoints   = avgOf(formTotals.points,   formCount);
    const formRebounds = avgOf(formTotals.rebounds,  formCount);
    const formAssists  = avgOf(formTotals.assists,   formCount);
    const formThrees   = avgOf(formTotals.tpm,       formCount);
    const formMinutes  = avgOf(formTotals.minutes,   formCount);

    // EDGE averages (last 10) — reliable recent average, drives edge %
    const edgeCount    = edgeGames.length || 1;
    const avgPoints    = avgOf(edgeTotals.points,   edgeCount);
    const avgRebounds  = avgOf(edgeTotals.rebounds,  edgeCount);
    const avgAssists   = avgOf(edgeTotals.assists,   edgeCount);
    const avgThrees    = avgOf(edgeTotals.tpm,       edgeCount);
    const avgMinutes   = avgOf(edgeTotals.minutes,   edgeCount);
    const avgFGA       = avgOf(edgeTotals.fga,       edgeCount);
    const avgFTA       = avgOf(edgeTotals.fta,       edgeCount);
    const avgTOV       = avgOf(edgeTotals.turnovers, edgeCount);

    // BASELINE averages (last 30) — what book priced the line against
    const baselineCount    = baselineGames.length || 1;
    const baselinePoints   = avgOf(baselineTotals.points,   baselineCount);
    const baselineRebounds = avgOf(baselineTotals.rebounds,  baselineCount);
    const baselineAssists  = avgOf(baselineTotals.assists,   baselineCount);
    const baselineThrees   = avgOf(baselineTotals.tpm,       baselineCount);
    const baselineMinutes  = avgOf(baselineTotals.minutes,   baselineCount);

    // ── True Shooting % (TS%) ─────────────────────────────────────────────
    // Formula: PTS / (2 * (FGA + 0.44 * FTA)) — capped at 100% (can't exceed)
    // Uses BASELINE window (30 games) for statistical reliability
    const bTotals      = baselineTotals; // use baseline for efficiency metrics
    const tsDenominator = 2 * (bTotals.fga + 0.44 * bTotals.fta);
    const tsRaw = tsDenominator > 0
      ? (bTotals.points / tsDenominator) * 100
      : 0;
    // Cap at 100 — any value above indicates data quality issue (missing FGA/FTA records)
    const trueShootingPct = tsRaw > 100 || tsRaw <= 0
      ? null  // null = don't show — bad data is worse than no data
      : parseFloat(tsRaw.toFixed(1));

    // ── Effective Field Goal % (eFG%) ─────────────────────────────────────
    const efgRaw = bTotals.fga > 0
      ? ((bTotals.fgm + 0.5 * bTotals.tpm) / bTotals.fga) * 100
      : 0;
    const effectiveFGPct = efgRaw > 100 || efgRaw <= 0
      ? null
      : parseFloat(efgRaw.toFixed(1));

    // ── Usage Rate (USG%) ─────────────────────────────────────────────────
    // Approximation: % of team possessions ending with this player
    // Simplified formula (full formula requires team data): (FGA + 0.44*FTA + TOV) / (MIN * team_pace)
    // We use an approximation here — real USG% needs team data
    const approxUSGPct = avgMinutes > 0
      ? parseFloat(((avgFGA + 0.44 * avgFTA + avgTOV) / (avgMinutes * 0.2) * 100).toFixed(1))
      : 0;

    // ── Recent values for the specific stat (for confidence scoring) ───────
    // Map stat types to the new nested field structure
    const recentStatValues = recentGames.map((game) => ({
      points:   game.points                     || 0,
      rebounds: game.rebounds?.total            || 0,
      assists:  game.assists                    || 0,
      threes:   game.threepoint_goals?.total    || 0,
    }[statType] || 0));

    return {
      // Raw averages
      // Recent form (last 5 games) — primary signal
      avgPoints,
      avgRebounds,
      avgAssists,
      avgThrees,
      avgMinutes,
      // Season baseline (last 30 games) — context / what book's line is based on
      baselinePoints,
      baselineRebounds,
      baselineAssists,
      baselineThrees,
      baselineMinutes,
      // How many games in each group (may be less than window if season just started)
      formGamesCount:     formCount,
      baselineGamesCount: baselineCount,

      // Advanced metrics
      trueShootingPct,    // TS%
      effectiveFGPct,     // eFG%
      approxUSGPct,       // USG% (approximated)

      // Recent values for the target stat (used for confidence calculation)
      recentStatValues,

      // Sample size (how many games data is based on)
      gamesAnalyzed: totalGames,

      // The main stat being analyzed
      focusStat: statType,
      // focusStatAvg = recent form average for the stat being bet on
      // This is what drives edge % — we compare recent form to the book's line
      // Book's line ≈ baselineStat, so divergence = edge
      focusStatAvg: statType === 'points'   ? avgPoints
        : statType === 'rebounds' ? avgRebounds
        : statType === 'assists'  ? avgAssists
        : avgThrees,

      // baselineStatAvg = season average the bookmaker is pricing against
      baselineStatAvg: statType === 'points'   ? baselinePoints
        : statType === 'rebounds' ? baselineRebounds
        : statType === 'assists'  ? baselineAssists
        : baselineThrees,
    };
  }

  // ─── AI Prompt Building ────────────────────────────────────────────────────

  /**
   * Build the NBA-specific AI prompt.
   * MANDATORY: Must include the betting line in the prompt.
   * The AI performs significantly better when given a target (from architecture plan).
   *
   * @param {Object} params
   * @returns {string} Prompt string for OpenAI
   */
  buildPrompt({ processedStats, playerName, statType, bettingLine, marketType }) {
    const stats = processedStats || {};
    const {
      avgPoints = 'N/A', avgRebounds = 'N/A', avgAssists = 'N/A',
      avgThrees = 'N/A', avgMinutes = 'N/A', focusStatAvg = 'N/A',
      edgeGamesCount = 10,
      formPoints = 'N/A', formRebounds = 'N/A', formAssists = 'N/A',
      formThrees = 'N/A', formMinutes = 'N/A', formGamesCount = 5,
      recentStatValues = [],
      baselineStatAvg = 'N/A', baselineMinutes = 'N/A', baselineGamesCount = 30,
      trueShootingPct = 'N/A', effectiveFGPct = 'N/A', approxUSGPct = 'N/A',
    } = stats;

    const statLabel = {
      points: 'points', rebounds: 'total rebounds',
      assists: 'assists', threes: '3-pointers made',
    }[statType] || statType;

    const recentStr = recentStatValues.length > 0
      ? recentStatValues.join(', ') : 'No recent data';

    const formStat = {
      points: formPoints, rebounds: formRebounds,
      assists: formAssists, threes: formThrees,
    }[statType] ?? 'N/A';

    const edgeNum = parseFloat(focusStatAvg) || 0;
    const lineNum = parseFloat(bettingLine)  || 0;
    const dataSignal = edgeNum > 0 && lineNum > 0
      ? (edgeNum > lineNum ? 'OVER' : 'UNDER')
      : 'INSUFFICIENT_DATA';

    return `You are an expert NBA prop betting analyst.

Analyze this player prop and respond with ONLY a JSON object — no markdown, no explanation outside the JSON.

PLAYER: ${playerName}
STAT: ${statLabel}
LINE: ${bettingLine}
DATA SIGNAL: ${dataSignal} (based on 10-game avg of ${focusStatAvg} vs line of ${bettingLine})

THREE-WINDOW DATA:
- CURRENT FORM (last ${formGamesCount} games): avg ${formStat}, minutes ${formMinutes}, game log: ${recentStr}
- RECENT TREND (last ${edgeGamesCount} games): avg ${focusStatAvg}, minutes ${avgMinutes}
- SEASON BASELINE (last ${baselineGamesCount} games): avg ${baselineStatAvg}, minutes ${baselineMinutes}
- EFFICIENCY: TS% ${trueShootingPct != null ? trueShootingPct + '%' : 'N/A (insufficient shot data)'}, eFG% ${effectiveFGPct != null ? effectiveFGPct + '%' : 'N/A'}, USG% ${approxUSGPct}%

Return this exact JSON structure:
{
  "recommendation": "over" or "under",
  "confidence": "low" or "medium" or "high",
  "summary": "One sentence (max 25 words) stating the bet and the single most important reason",
  "factors": [
    "Factor 1 — cite the specific window and number (e.g. 10-game avg of 11.2 is well below line of 16.5)",
    "Factor 2 — cite a different window or metric",
    "Factor 3 — cite efficiency or minutes context"
  ],
  "risks": [
    "Primary risk that could make this prediction wrong",
    "Secondary risk (optional)"
  ],
  "dataQuality": "strong" or "moderate" or "weak"
}

Rules:
- recommendation MUST match the DATA SIGNAL unless you have strong reason to override — explain in summary if overriding
- factors and risks must reference specific numbers from the data above
- dataQuality is "weak" if any window has N/A or 0 values, "moderate" if partial data, "strong" if all three windows have real data
- respond with ONLY the JSON — no backticks, no extra text`;
  }

  // ─── Normalization ─────────────────────────────────────────────────────────

  /**
   * Normalize a raw game object from The Odds API to match Game.model.js schema.
   *
   * @param {Object} rawGame
   * @returns {Object} Normalized game object
   */
  normalizeGame(rawGame) {
    return {
      sport: this.sport,
      league: 'NBA',
      oddsEventId: rawGame.id,
      homeTeam: {
        name:         rawGame.home_team,
        abbreviation: this._getTeamAbbreviation(rawGame.home_team),
        apiSportsId:  this._getApiSportsTeamId(rawGame.home_team),
      },
      awayTeam: {
        name:         rawGame.away_team,
        abbreviation: this._getTeamAbbreviation(rawGame.away_team),
        apiSportsId:  this._getApiSportsTeamId(rawGame.away_team),
      },
      startTime: new Date(rawGame.commence_time),
      status: 'scheduled',
    };
  }

  /**
   * Map full NBA team names to their API-Sports Basketball team IDs.
    * IDs are a static reference map used internally for team linkage.
    * They are not fetched live from API endpoints at runtime.
   *
   * @param {string} teamName - Full team name from The Odds API
   * @returns {number|null} API-Sports team ID
   */
  _getApiSportsTeamId(teamName) {
    const teamIds = {
      'Atlanta Hawks':          133,
      'Boston Celtics':         134,
      'Brooklyn Nets':          135,
      'Charlotte Hornets':      136,
      'Chicago Bulls':          137,
      'Cleveland Cavaliers':    138,
      'Dallas Mavericks':       139,
      'Denver Nuggets':         140,
      'Detroit Pistons':        141,
      'Golden State Warriors':  142,
      'Houston Rockets':        143,
      'Indiana Pacers':         144,
      'Los Angeles Clippers':   145,
      'Los Angeles Lakers':     146,
      'Memphis Grizzlies':      147,
      'Miami Heat':             148,
      'Milwaukee Bucks':        149,
      'Minnesota Timberwolves': 150,
      'New Orleans Pelicans':   151,
      'New York Knicks':        152,
      'Oklahoma City Thunder':  153,
      'Orlando Magic':          154,
      'Philadelphia 76ers':     155,
      'Phoenix Suns':           156,
      'Portland Trail Blazers': 157,
      'Sacramento Kings':       158,
      'San Antonio Spurs':      159,
      'Toronto Raptors':        160,
      'Utah Jazz':              161,
      'Washington Wizards':     162,
    };
    return teamIds[teamName] || null;
  }

  /**
   * Normalize a prop object to match PlayerProp.model.js schema.
   *
   * @param {Object} rawProp - Already extracted prop object
   * @returns {Object} Normalized prop
   */
  normalizeProp(rawProp) {
    return {
      sport: this.sport,
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

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Parse the raw Odds API response and extract individual player props.
   * The Odds API nests props inside bookmaker → market → outcomes.
   *
   * @param {Object} eventData - Full event response from The Odds API
   * @param {string} oddsEventId
   * @returns {Array} Flat array of prop objects
   */
  _extractPropsFromOddsResponse(eventData, oddsEventId) {
    const props = [];

    // Map Odds API market keys to our internal stat types
    const marketToStatType = {
      player_points: 'points',
      player_rebounds: 'rebounds',
      player_assists: 'assists',
      player_threes: 'threes',
    };

    const bookmakers = eventData.bookmakers || [];

    for (const bookmaker of bookmakers) {
      const bookmakerName = bookmaker.title; // e.g., "DraftKings"

      for (const market of bookmaker.markets || []) {
        const statType = marketToStatType[market.key];
        if (!statType) continue; // Skip unknown markets

        // Each market has outcomes grouped by player name
        // Outcomes come in pairs: one OVER and one UNDER for each player
        const outcomesByPlayer = {};

        for (const outcome of market.outcomes || []) {
          // outcome.description = player name
          // outcome.name = "Over" or "Under"
          // outcome.point = the line (e.g., 25.5)
          // outcome.price = American odds (e.g., -110)
          const playerName = outcome.description;

          if (!outcomesByPlayer[playerName]) {
            outcomesByPlayer[playerName] = { playerName, statType, bookmaker: bookmakerName, oddsEventId };
          }

          if (outcome.name === 'Over') {
            outcomesByPlayer[playerName].line = outcome.point;
            outcomesByPlayer[playerName].overOdds = outcome.price;
          } else if (outcome.name === 'Under') {
            outcomesByPlayer[playerName].underOdds = outcome.price;
          }
        }

        // Only add props where we have both over and under odds + a line
        for (const prop of Object.values(outcomesByPlayer)) {
          if (prop.line !== undefined && prop.overOdds !== undefined) {
            props.push(prop);
          }
        }
      }

      // Use first bookmaker with data (DraftKings preferred if available)
      if (props.length > 0 && bookmakerName === 'DraftKings') break;
    }

    logger.debug(`[NBA] Extracted ${props.length} props from event ${oddsEventId}`);
    return props;
  }

  /**
   * Map full team names to abbreviations.
   * Used for display in the frontend.
   *
   * @param {string} teamName - Full team name (e.g., "Los Angeles Lakers")
   * @returns {string} Abbreviation (e.g., "LAL")
   */
  _getTeamAbbreviation(teamName) {
    const abbrevMap = {
      'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
      'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
      'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
      'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
      'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
      'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
      'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
      'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
      'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
      'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
    };
    return abbrevMap[teamName] || teamName.substring(0, 3).toUpperCase();
  }
}

module.exports = NBAAdapter;
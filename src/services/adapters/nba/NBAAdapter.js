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
 *  Stats → API-Sports Basketball (https://v1.basketball.api-sports.io)
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
const axios = require('axios');
const logger = require('../../../config/logger');

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

    // ── API-Sports Basketball config ──────────────────────────────────────────
    // Default to v1 basketball API — set API_SPORTS_BASE_URL in .env to override
    this.statsApiBase = process.env.API_SPORTS_BASE_URL || 'https://v1.basketball.api-sports.io';
    this.statsApiKey  = process.env.API_SPORTS_KEY;

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
   * Fetch player statistics from API-Sports Basketball.
   * Returns season averages + recent games for the player.
   *
   * @param {Object} params
   * @param {number} params.playerId - API-Sports player ID
   * @param {string} params.season   - Season year (e.g., "2023-2024")
   * @returns {Promise<Object>} Raw player stats
   */
  async fetchPlayerStats({ playerId, season }) {
    // Default to current season dynamically — avoids stale hardcoded value
    if (!season) {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1; // 1-indexed
      // API-Sports Basketball uses just the START year of the season
      // NBA 2025-2026 season → season param = "2025"
      // If before October, we're in the previous season's year
      season = month >= 10 ? String(year) : String(year - 1);
    }
    try {
      logger.info(`📈 [NBA] Fetching player stats`, { playerId, season });

      const response = await axios.get(`${this.statsApiBase}/players/statistics`, {
        headers: {
          'x-apisports-key': this.statsApiKey,
        },
        params: {
          id: playerId,
          season,
          // NOTE: /players/statistics in API-Sports Basketball does NOT accept
          // a league param — it returns all stats for the player in that season
        },
        timeout: 10000,
      });

      const stats = response.data?.response || [];

      // Debug: log if API returns an error or empty (helps diagnose key/plan issues)
      if (response.data?.errors && Object.keys(response.data.errors).length > 0) {
        logger.warn(`⚠️  [NBA] API-Sports returned errors for player ${playerId}`, {
          errors: response.data.errors,
          season,
        });
      }

      logger.info(`✅ [NBA] Fetched stats for player ${playerId}: ${stats.length} game records`, {
        season,
        resultsTotal: response.data?.results,
        hasErrors: Object.keys(response.data?.errors || {}).length > 0,
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
  applyFormulas(rawStats, statType = 'points') {
    if (!rawStats || rawStats.length === 0) {
      logger.warn('[NBA] applyFormulas: no raw stats provided');
      return {};
    }

    // Work with last 10 games for recent form analysis
    const recentGames = rawStats.slice(-10);
    const totalGames = recentGames.length;

    // ── Extract raw values from recent games ────────────────────────────────
    const totals = recentGames.reduce(
      (acc, game) => {
        const g = game.game || {};
        acc.points += game.points || 0;
        acc.fgm += game.fgm || 0;
        acc.fga += game.fga || 0;
        acc.ftm += game.ftm || 0;
        acc.fta += game.fta || 0;
        acc.tpm += game.tpm || 0; // 3-pointers made
        acc.tpa += game.tpa || 0; // 3-pointers attempted
        acc.rebounds += game.totReb || 0;
        acc.assists += game.assists || 0;
        acc.turnovers += game.turnovers || 0;
        acc.minutes += parseFloat(game.min) || 0;
        return acc;
      },
      { points: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, tpa: 0, rebounds: 0, assists: 0, turnovers: 0, minutes: 0 }
    );

    // ── Compute averages ────────────────────────────────────────────────────
    const avg = (val) => (totalGames > 0 ? parseFloat((val / totalGames).toFixed(1)) : 0);

    const avgPoints = avg(totals.points);
    const avgRebounds = avg(totals.rebounds);
    const avgAssists = avg(totals.assists);
    const avgThrees = avg(totals.tpm);
    const avgMinutes = avg(totals.minutes);
    const avgFGA = avg(totals.fga);
    const avgFTA = avg(totals.fta);
    const avgTOV = avg(totals.turnovers);

    // ── True Shooting % (TS%) ─────────────────────────────────────────────
    // Measures overall scoring efficiency (accounts for FT value and 3pt value)
    // Higher is better. Elite players: 60%+. League average: ~56%
    // Formula: PTS / (2 * (FGA + 0.44 * FTA))
    const tsDenominator = 2 * (totals.fga + 0.44 * totals.fta);
    const trueShootingPct = tsDenominator > 0
      ? parseFloat(((totals.points / tsDenominator) * 100).toFixed(1))
      : 0;

    // ── Effective Field Goal % (eFG%) ─────────────────────────────────────
    // Like FG% but gives 3-pointers extra credit (they're worth 50% more)
    // Formula: (FGM + 0.5 * 3PM) / FGA
    const effectiveFGPct = totals.fga > 0
      ? parseFloat((((totals.fgm + 0.5 * totals.tpm) / totals.fga) * 100).toFixed(1))
      : 0;

    // ── Usage Rate (USG%) ─────────────────────────────────────────────────
    // Approximation: % of team possessions ending with this player
    // Simplified formula (full formula requires team data): (FGA + 0.44*FTA + TOV) / (MIN * team_pace)
    // We use an approximation here — real USG% needs team data
    const approxUSGPct = avgMinutes > 0
      ? parseFloat(((avgFGA + 0.44 * avgFTA + avgTOV) / (avgMinutes * 0.2) * 100).toFixed(1))
      : 0;

    // ── Recent values for the specific stat (for confidence scoring) ───────
    const recentStatValues = recentGames.map((game) => {
      const statMap = {
        points: game.points || 0,
        rebounds: game.totReb || 0,
        assists: game.assists || 0,
        threes: game.tpm || 0,
      };
      return statMap[statType] || 0;
    });

    return {
      // Raw averages
      avgPoints,
      avgRebounds,
      avgAssists,
      avgThrees,
      avgMinutes,

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
      focusStatAvg: statType === 'points' ? avgPoints
        : statType === 'rebounds' ? avgRebounds
        : statType === 'assists' ? avgAssists
        : avgThrees,
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
    // Guard: processedStats may be empty if player stats unavailable
    const stats = processedStats || {};
    const {
      avgPoints    = 'N/A',
      avgRebounds  = 'N/A',
      avgAssists   = 'N/A',
      avgThrees    = 'N/A',
      avgMinutes   = 'N/A',
      trueShootingPct = 'N/A',
      effectiveFGPct  = 'N/A',
      approxUSGPct    = 'N/A',
      recentStatValues = [],
      gamesAnalyzed    = 0,
      focusStatAvg     = 'N/A',
    } = stats;

    // Format recent values as a readable list (e.g., "28, 31, 24, 29, 22")
    const recentValuesStr = recentStatValues.length > 0
      ? recentStatValues.join(', ')
      : 'No recent game data available';

    const statLabel = {
      points: 'points',
      rebounds: 'total rebounds',
      assists: 'assists',
      threes: '3-pointers made',
    }[statType] || statType;

    return `
Analyze the following NBA player prop bet and give a clear recommendation.

PLAYER: ${playerName}
PROP: ${statLabel.toUpperCase()}
BETTING LINE: ${bettingLine} (Should we bet OVER or UNDER ${bettingLine} ${statLabel}?)

RECENT PERFORMANCE (Last ${gamesAnalyzed} games):
- Average ${statLabel}: ${focusStatAvg} per game
- Recent game-by-game ${statLabel}: ${recentValuesStr}

SUPPORTING STATS (season averages):
- Points per game: ${avgPoints}
- Rebounds per game: ${avgRebounds}
- Assists per game: ${avgAssists}
- 3-Pointers made per game: ${avgThrees}
- Minutes per game: ${avgMinutes}

ADVANCED EFFICIENCY METRICS:
- True Shooting % (TS%): ${trueShootingPct}% [measures overall scoring efficiency; elite = 60%+]
- Effective Field Goal % (eFG%): ${effectiveFGPct}% [adjusts for 3-pointers; above 52% is above average]
- Approximate Usage Rate (USG%): ${approxUSGPct}% [how often team plays run through this player; high usage means more opportunities]

TASK:
1. Give a clear recommendation: OVER ${bettingLine} or UNDER ${bettingLine} ${statLabel}
2. State your confidence level (Low / Medium / High)
3. Provide 2–3 specific statistical reasons for your recommendation
4. Note any key risk factors that could affect the outcome

Be concise and data-driven. Maximum 150 words.
`.trim();
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
   * IDs sourced from: https://v1.basketball.api-sports.io/teams?league=12&season=2024
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
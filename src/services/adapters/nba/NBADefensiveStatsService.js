/**
 * NBADefensiveStatsService.js — NBA team defensive stats for opponent context
 *
 * DATA SOURCE: API-Sports NBA v2 /teams/statistics
 *   GET /teams/statistics?id={teamId}&season={season}&league=12
 *   Same API key as player stats — no extra cost, counts against 100/day quota.
 *
 * CONFIRMED RESPONSE FIELDS (basketball v2):
 *   response[0].games.played.all                         → games played
 *   response[0].points.against.average.all               → points allowed per game
 *   response[0].threePoints.against.average.all          → threes allowed per game
 *   response[0].rebounds.total.against.average.all       → total reb allowed per game
 *
 * CACHE: 24h TTL — team defensive ratings change slowly (use same key per day)
 *
 * WHY THIS MATTERS:
 *  A player averaging 2.1 threes per game facing a team that allows 15.2 threes
 *  per game (league avg 13.1) is significantly more likely to go OVER.
 *  Conversely, facing a team allowing only 10.8 threes → lean UNDER.
 *  This context was completely missing before Session 3.
 *
 * USAGE:
 *  InsightService calls getGameDefensiveContext(game) which returns stats
 *  for BOTH teams. The prompt builder then picks the opponent's stats
 *  based on which team the player is on (or shows both with labels).
 *
 * NBA 2024-25 LEAGUE AVERAGES (for context in prompt):
 *  Points allowed:     ~113.5 PPG
 *  Threes allowed:     ~13.1 per game
 *  Rebounds allowed:   ~44.4 per game
 */

const logger         = require('../../../config/logger');
const ApiSportsClient = require('../shared/ApiSportsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');

const DEF_STATS_CACHE_TTL = 24 * 60 * 60; // 24h — defensive ratings change slowly

// 2024-25 NBA league averages for context labels
const LEAGUE_AVERAGES = {
  pointsAllowedPG:   113.5,
  threesAllowedPG:   13.1,
  reboundsAllowedPG: 44.4,
};

let statsClient = null;
const _getClient = () => {
  if (!statsClient) statsClient = new ApiSportsClient('nba');
  return statsClient;
};

const _getSeason = (now = new Date()) => {
  const yr = now.getFullYear();
  return (now.getMonth() + 1) >= 10 ? yr : yr - 1;
};

/**
 * Fetch defensive stats for one NBA team.
 *
 * @param {number} teamId  - API-Sports team ID (from teamMaps.js)
 * @param {string} teamName - Team name for logging
 * @returns {Promise<Object|null>}
 *   { pointsAllowedPG, threesAllowedPG, reboundsAllowedPG, gamesPlayed, teamName }
 */
async function fetchTeamDefensiveStats(teamId, teamName = '') {
  if (!teamId) return null;

  const season   = _getSeason();
  const dateKey  = new Date().toISOString().split('T')[0]; // re-fetch daily
  const cacheKey = `nba:defstats:${teamId}:${season}:${dateKey}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const client = _getClient();
    const data   = await client.get('teams/statistics', {
      id:     teamId,
      season: season,
      league: 12,
    });

    // API-Sports returns array — first element is the team stats object
    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) {
      logger.warn('[NBADefStats] No stats returned', { teamId, teamName });
      return null;
    }

    const gamesPlayed = stats.games?.played?.all || null;

    // Points allowed
    const pointsAllowedPG = parseFloat(
      stats.points?.against?.average?.all || 0
    ) || null;

    // Threes allowed (3PM allowed by this defense per game)
    const threesAllowedPG = parseFloat(
      stats.threePoints?.against?.average?.all || 0
    ) || null;

    // Total rebounds allowed per game
    const reboundsAllowedPG = parseFloat(
      stats.rebounds?.total?.against?.average?.all || 0
    ) || null;

    if (!pointsAllowedPG && !threesAllowedPG && !reboundsAllowedPG) {
      logger.warn('[NBADefStats] All stats null — field names may have changed', {
        teamId, teamName,
        sampleKeys: Object.keys(stats).slice(0, 8),
      });
      return null;
    }

    const result = {
      teamId,
      teamName:          teamName || String(teamId),
      gamesPlayed,
      pointsAllowedPG,
      threesAllowedPG,
      reboundsAllowedPG,
      season,
    };

    await cacheSet(cacheKey, result, DEF_STATS_CACHE_TTL);
    logger.debug('[NBADefStats] Fetched', {
      teamName,
      pointsAllowedPG,
      threesAllowedPG,
      reboundsAllowedPG,
    });

    return result;
  } catch (err) {
    logger.error('[NBADefStats] fetchTeamDefensiveStats failed', {
      teamId, teamName, error: err.message,
    });
    return null;
  }
}

/**
 * Fetch defensive stats for both teams in a game.
 * Called by InsightService after game context detection.
 *
 * @param {Object} game - Normalized game document
 *   { homeTeam: { name, apiSportsId }, awayTeam: { name, apiSportsId } }
 * @returns {Promise<{ homeTeamDef: Object|null, awayTeamDef: Object|null }>}
 */
async function getGameDefensiveContext(game) {
  if (!game) return { homeTeamDef: null, awayTeamDef: null };

  const homeId   = game.homeTeam?.apiSportsId;
  const awayId   = game.awayTeam?.apiSportsId;
  const homeName = game.homeTeam?.name || '';
  const awayName = game.awayTeam?.name || '';

  if (!homeId && !awayId) {
    logger.debug('[NBADefStats] No team IDs on game document', {
      homeTeam: homeName, awayTeam: awayName,
    });
    return { homeTeamDef: null, awayTeamDef: null };
  }

  // Fetch both teams in parallel — 2 API calls per insight but cached 24h
  const [homeTeamDef, awayTeamDef] = await Promise.all([
    homeId ? fetchTeamDefensiveStats(homeId, homeName) : Promise.resolve(null),
    awayId ? fetchTeamDefensiveStats(awayId, awayName) : Promise.resolve(null),
  ]);

  return { homeTeamDef, awayTeamDef };
}

/**
 * Build the defensive context block for the NBA AI prompt.
 *
 * Determines which team is the OPPONENT for this player, then shows
 * that opponent's defensive stats vs league average.
 *
 * Player team assignment:
 *  We can't always know which team the player is on from the prop alone.
 *  Strategy: show BOTH teams' defense with home/away labels.
 *  The AI understands which team is defending against the player.
 *
 * @param {string} statType  - 'points' | 'threes' | 'rebounds' | 'assists'
 * @param {Object} homeTeamDef
 * @param {Object} awayTeamDef
 * @returns {string} Formatted context block or ''
 */
function buildDefensiveContextBlock(statType, homeTeamDef, awayTeamDef) {
  if (!homeTeamDef && !awayTeamDef) return '';

  const lines = ['OPPONENT DEFENSIVE CONTEXT:'];

  const formatTeam = (def, role) => {
    if (!def) return `  ${role} defense: data unavailable`;

    const teamStr = `${role} (${def.teamName})`;
    const leagueRef = LEAGUE_AVERAGES;

    if (statType === 'threes') {
      const allowed = def.threesAllowedPG;
      if (allowed === null) return `  ${teamStr}: threes-allowed data unavailable`;
      const diff   = allowed - leagueRef.threesAllowedPG;
      const label  = diff > 1.5 ? '🔴 POOR (OVER lean)' : diff < -1.5 ? '🟢 STRONG (UNDER lean)' : '⚪ average';
      return `  ${teamStr}: allows ${allowed} 3PM/g (league avg ${leagueRef.threesAllowedPG}) → ${label}`;
    }

    if (statType === 'rebounds') {
      const allowed = def.reboundsAllowedPG;
      if (allowed === null) return `  ${teamStr}: rebounds-allowed data unavailable`;
      const diff   = allowed - leagueRef.reboundsAllowedPG;
      const label  = diff > 2.0 ? '🔴 POOR (OVER lean)' : diff < -2.0 ? '🟢 STRONG (UNDER lean)' : '⚪ average';
      return `  ${teamStr}: allows ${allowed} reb/g (league avg ${leagueRef.reboundsAllowedPG}) → ${label}`;
    }

    if (statType === 'points') {
      const allowed = def.pointsAllowedPG;
      if (allowed === null) return `  ${teamStr}: points-allowed data unavailable`;
      const diff   = allowed - leagueRef.pointsAllowedPG;
      const label  = diff > 3.0 ? '🔴 POOR defense (OVER lean)' : diff < -3.0 ? '🟢 STRONG defense (UNDER lean)' : '⚪ average defense';
      return `  ${teamStr}: allows ${allowed} PPG (league avg ${leagueRef.pointsAllowedPG}) → ${label}`;
    }

    // assists — use points allowed as proxy for pace/offense-friendly
    if (statType === 'assists') {
      const allowed = def.pointsAllowedPG;
      if (allowed === null) return `  ${teamStr}: defense data unavailable`;
      const label = allowed > 116 ? 'pace-up defense (more possessions)' : allowed < 111 ? 'grind-it-out defense (fewer possessions)' : 'average pace';
      return `  ${teamStr}: ${allowed} PPG allowed → ${label}`;
    }

    return '';
  };

  lines.push(formatTeam(homeTeamDef, 'HOME'));
  lines.push(formatTeam(awayTeamDef, 'AWAY'));
  lines.push('  (Player faces the OPPOSING team\'s defense — use home/away context from PLAYER + STAT above)');

  return lines.filter(Boolean).join('\n');
}

module.exports = {
  fetchTeamDefensiveStats,
  getGameDefensiveContext,
  buildDefensiveContextBlock,
  LEAGUE_AVERAGES,
};
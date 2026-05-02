/**
 * NHLStatsClient.js — Official NHL Stats API client
 *
 * Base: https://api-web.nhle.com/v1
 * No API key required. Free, official, used by NHL.com itself.
 *
 * ENDPOINTS USED:
 *   /roster/{teamAbbrev}/current     → player IDs for a team
 *   /player/{playerId}/game-log/{season}/{gameType} → game-by-game stats
 *   /club-stats/{teamAbbrev}/now     → team season stats (PP%, SOG)
 *
 * SEASON FORMAT: "20242025" (no dash, start year + end year concatenated)
 * GAME TYPE:     2 = regular season, 3 = playoffs
 *
 * CACHING:
 *   Rosters:   24h (rarely changes mid-season)
 *   Game logs:  4h (updated after each game)
 *   Team stats: 6h (slow-changing)
 */

const axios  = require('axios');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const BASE_URL     = 'https://api-web.nhle.com/v1';
const TIMEOUT_MS   = 10_000;

// Cache TTLs
const TTL_ROSTER     = 24 * 3600;
const TTL_GAME_LOG   =  4 * 3600;
const TTL_TEAM_STATS =  6 * 3600;
const TTL_PLAYER_ID  = 30 * 24 * 3600; // 30 days — player IDs are stable

// ── Team name → NHL 3-letter abbreviation map ────────────────────────────────
// Full name exactly as stored in Game.homeTeam.name / awayTeam.name
const TEAM_ABBREV = {
  'Anaheim Ducks':          'ANA',
  'Boston Bruins':          'BOS',
  'Buffalo Sabres':         'BUF',
  'Calgary Flames':         'CGY',
  'Carolina Hurricanes':    'CAR',
  'Chicago Blackhawks':     'CHI',
  'Colorado Avalanche':     'COL',
  'Columbus Blue Jackets':  'CBJ',
  'Dallas Stars':           'DAL',
  'Detroit Red Wings':      'DET',
  'Edmonton Oilers':        'EDM',
  'Florida Panthers':       'FLA',
  'Los Angeles Kings':      'LAK',
  'Minnesota Wild':         'MIN',
  'Montréal Canadiens':     'MTL',
  'Montreal Canadiens':     'MTL',
  'Nashville Predators':    'NSH',
  'New Jersey Devils':      'NJD',
  'New York Islanders':     'NYI',
  'New York Rangers':       'NYR',
  'Ottawa Senators':        'OTT',
  'Philadelphia Flyers':    'PHI',
  'Pittsburgh Penguins':    'PIT',
  'San Jose Sharks':        'SJS',
  'Seattle Kraken':         'SEA',
  'St. Louis Blues':        'STL',
  'Tampa Bay Lightning':    'TBL',
  'Toronto Maple Leafs':    'TOR',
  'Utah Hockey Club':       'UTA',
  'Utah Mammoth':           'UTA',
  'Vancouver Canucks':      'VAN',
  'Vegas Golden Knights':   'VGK',
  'Washington Capitals':    'WSH',
  'Winnipeg Jets':          'WPG',
};

// ── Season helpers ────────────────────────────────────────────────────────────

function getCurrentSeason() {
  const now = new Date();
  const yr  = now.getFullYear();
  const startYear = (now.getMonth() + 1) >= 10 ? yr : yr - 1;
  return `${startYear}${startYear + 1}`;
}

function getGameType() {
  // Playoffs: typically Apr 19 – Jun 30
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const isPlayoffs = (month === 4 && day >= 19) || month === 5 || (month === 6 && day <= 30);
  return isPlayoffs ? 3 : 2;
}

function getTeamAbbrev(teamName) {
  if (!teamName) return null;
  // Direct match
  if (TEAM_ABBREV[teamName]) return TEAM_ABBREV[teamName];
  // Fuzzy: try lowercase contains
  const lower = teamName.toLowerCase();
  for (const [name, abbrev] of Object.entries(TEAM_ABBREV)) {
    if (lower.includes(name.toLowerCase().split(' ').slice(-1)[0])) return abbrev;
  }
  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function _get(path) {
  const url = `${BASE_URL}${path}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: {
      'User-Agent':      'Mozilla/5.0 (compatible; SignalDraft/1.0)',
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://www.nhl.com/',
    },
  });
  return res.data;
}

// ── Player ID resolution ──────────────────────────────────────────────────────

/**
 * Get all players for a team (forwards + defensemen + goalies).
 * Returns Map<normalizedName, { id, position, firstName, lastName }>
 *
 * @param {string} teamName — full team name e.g. "Boston Bruins"
 */
async function getTeamRoster(teamName) {
  const abbrev = getTeamAbbrev(teamName);
  if (!abbrev) {
    logger.warn(`[NHLStatsClient] No abbreviation found for team: "${teamName}"`);
    return new Map();
  }

  const cacheKey = `nhl:roster:${abbrev}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  try {
    const data = await _get(`/roster/${abbrev}/current`);
    const allPlayers = [
      ...(data.forwards   || []).map(p => ({ ...p, position: 'F' })),
      ...(data.defensemen || []).map(p => ({ ...p, position: 'D' })),
      ...(data.goalies    || []).map(p => ({ ...p, position: 'G' })),
    ];

    const result = {};
    for (const p of allPlayers) {
      const first = p.firstName?.default || '';
      const last  = p.lastName?.default  || '';
      const full  = `${first} ${last}`.trim();
      const key   = _normName(full);
      if (key) {
        result[key] = {
          id:        p.id,
          position:  p.position,
          firstName: first,
          lastName:  last,
          fullName:  full,
        };
      }
    }

    await cacheSet(cacheKey, result, TTL_ROSTER);
    logger.debug(`[NHLStatsClient] Roster cached: ${abbrev} (${Object.keys(result).length} players)`);
    return new Map(Object.entries(result));

  } catch (err) {
    logger.error('[NHLStatsClient] getTeamRoster failed', { teamName, abbrev, error: err.message });
    return new Map();
  }
}

/**
 * Look up a player's NHL Stats API ID by name.
 * Searches both teams' rosters (home + away).
 *
 * @param {string} playerName
 * @param {string} homeTeamName
 * @param {string} awayTeamName
 * @returns {Promise<{ id, position } | null>}
 */
async function resolvePlayerId(playerName, homeTeamName, awayTeamName) {
  const normTarget = _normName(playerName);

  // Check individual player cache first
  const idCacheKey = `nhl:playerid:${normTarget}`;
  const cachedId   = await cacheGet(idCacheKey);
  if (cachedId) return cachedId;

  // Search both team rosters
  const teams  = [homeTeamName, awayTeamName].filter(Boolean);
  const rosters = await Promise.allSettled(teams.map(t => getTeamRoster(t)));

  for (const result of rosters) {
    if (result.status !== 'fulfilled') continue;
    const roster = result.value;

    // Exact match
    if (roster.has(normTarget)) {
      const player = roster.get(normTarget);
      await cacheSet(idCacheKey, player, TTL_PLAYER_ID);
      return player;
    }

    // Partial match (last name only — handles middle name differences)
    const lastName = normTarget.split(' ').slice(-1)[0];
    for (const [key, player] of roster) {
      if (key.endsWith(` ${lastName}`) || key === lastName) {
        await cacheSet(idCacheKey, player, TTL_PLAYER_ID);
        return player;
      }
    }
  }

  logger.debug(`[NHLStatsClient] Player not found in rosters: "${playerName}"`);
  return null;
}

// ── Player game log ───────────────────────────────────────────────────────────

/**
 * Fetch game-by-game stats for a player.
 * Tries current game type (regular/playoff), falls back to other type.
 *
 * @param {number} playerId  — NHL Stats API player ID
 * @param {string} season    — e.g. "20242025" (defaults to current)
 * @returns {Promise<Array>} normalized game log rows
 */
async function getPlayerGameLog(playerId, season = null) {
  const s        = season || getCurrentSeason();
  const gameType = getGameType();
  const cacheKey = `nhl:gamelog:${playerId}:${s}:${gameType}`;
  const cached   = await cacheGet(cacheKey);
  if (cached?.length > 0) return cached;

  try {
    const data = await _get(`/player/${playerId}/game-log/${s}/${gameType}`);
    const log  = data.gameLog || [];

    if (!log.length && gameType === 3) {
      // In playoffs but no playoff log yet — try regular season
      return getPlayerGameLog(playerId, s); // will try gameType=2 via fallback below
    }

    const normalized = log.map(g => ({
      gameDate:        g.gameDate,
      goals:           g.goals           ?? 0,
      assists:         g.assists         ?? 0,
      points:          g.points          ?? (g.goals + g.assists),
      shots:           g.shots           ?? 0,
      shotsOnGoal:     g.shots           ?? 0,
      toi:             g.toi             || '0:00',
      timeOnIce:       g.toi             || '0:00',
      powerPlayGoals:  g.powerPlayGoals  ?? 0,
      powerPlayPoints: g.powerPlayPoints ?? 0,
      shortHandedGoals: g.shortHandedGoals ?? 0,
      plusMinus:       g.plusMinus       ?? 0,
      pim:             g.penaltyMinutes  ?? 0,
      gameId:          g.gameId,
    }));

    await cacheSet(cacheKey, normalized, TTL_GAME_LOG);
    logger.info(`[NHLStatsClient] Game log: playerId=${playerId} season=${s} games=${normalized.length}`);
    return normalized;

  } catch (err) {
    // Try opposite game type as fallback
    if (gameType === 3) {
      try {
        const fallback = await _get(`/player/${playerId}/game-log/${s}/2`);
        const log2     = (fallback.gameLog || []).map(g => ({
          gameDate: g.gameDate, goals: g.goals ?? 0, assists: g.assists ?? 0,
          points: g.points ?? 0, shots: g.shots ?? 0, shotsOnGoal: g.shots ?? 0,
          toi: g.toi || '0:00', timeOnIce: g.toi || '0:00',
          powerPlayGoals: g.powerPlayGoals ?? 0, powerPlayPoints: g.powerPlayPoints ?? 0,
          plusMinus: g.plusMinus ?? 0, pim: g.penaltyMinutes ?? 0, gameId: g.gameId,
        }));
        await cacheSet(cacheKey, log2, TTL_GAME_LOG);
        return log2;
      } catch {}
    }
    logger.warn('[NHLStatsClient] getPlayerGameLog failed', { playerId, error: err.message });
    return [];
  }
}

// ── Team stats ────────────────────────────────────────────────────────────────

/**
 * Get team season stats: PP%, shots-for/against, goals-for/against.
 *
 * @param {string} teamName
 * @returns {Promise<{ ppPct, shotsForPerGame, shotsAgainstPerGame, goalsForPerGame, goalsAgainstPerGame } | null>}
 */
async function getTeamStats(teamName) {
  const abbrev = getTeamAbbrev(teamName);
  if (!abbrev) return null;

  const cacheKey = `nhl:teamstats:${abbrev}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await _get(`/club-stats/${abbrev}/now`);

    // Response shape: { season, gameType, skaters: [...], goalies: [...] }
    const skaters = data.skaters || [];
    const goalies = data.goalies || [];

    // Determine season games played (max among skaters)
    const gp = skaters.reduce((m, s) => Math.max(m, s.gamesPlayed || 0), 1) || 1;

    // Aggregate totals from skaters
    let totalGoals = 0, totalShots = 0, totalPPGoals = 0;
    for (const s of skaters) {
      totalGoals   += s.goals           ?? 0;
      totalShots   += s.shots           ?? 0;
      totalPPGoals += s.powerPlayGoals  ?? 0;
    }

    // Goals against: sum goalie goalsAgainst
    const totalGA = goalies.reduce((sum, g) => sum + (g.goalsAgainst ?? 0), 0);

    const result = {
      teamName,
      abbrev,
      gamesPlayed:         gp,
      ppPct:               null, // PP% not in club-stats endpoint; use /standings for that
      shotsForPerGame:     parseFloat((totalShots  / gp).toFixed(1)),
      shotsAgainstPerGame: null,
      goalsForPerGame:     parseFloat((totalGoals  / gp).toFixed(2)),
      goalsAgainstPerGame: parseFloat((totalGA     / gp).toFixed(2)),
    };

    await cacheSet(cacheKey, result, TTL_TEAM_STATS);
    return result;

  } catch (err) {
    logger.warn('[NHLStatsClient] getTeamStats failed', { teamName, error: err.message });
    return null;
  }
}

// ── Goalie stats ──────────────────────────────────────────────────────────────

/**
 * Get the likely starting goalie for a team + their save%.
 * Fetches team roster goalies, then gets game log for each,
 * returns the one with the most recent starts.
 *
 * @param {string} teamName
 * @returns {Promise<{ name, id, savePercentage, goalsAgainstAvg, gamesPlayed, tier } | null>}
 */
async function getStartingGoalie(teamName) {
  const cacheKey = `nhl:goalie:${_normName(teamName)}:${getCurrentSeason()}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const abbrev = getTeamAbbrev(teamName);
    if (!abbrev) return null;

    // club-stats returns { skaters, goalies } with season aggregates — no extra requests needed
    const data    = await _get(`/club-stats/${abbrev}/now`);
    const goalies = data.goalies || [];
    if (!goalies.length) return null;

    // Starter = most gamesStarted, fallback gamesPlayed
    const sorted = [...goalies].sort(
      (a, b) => ((b.gamesStarted ?? b.gamesPlayed) || 0) - ((a.gamesStarted ?? a.gamesPlayed) || 0)
    );
    const g = sorted[0];

    const name    = `${g.firstName?.default || ''} ${g.lastName?.default || ''}`.trim();
    const savePct = g.savePercentage != null ? parseFloat(g.savePercentage.toFixed(3)) : null;
    const gaa     = g.goalsAgainstAverage != null ? parseFloat(g.goalsAgainstAverage.toFixed(2)) : null;

    const result = {
      name,
      id:              g.playerId,
      savePercentage:  savePct,
      goalsAgainstAvg: gaa,
      gamesPlayed:     g.gamesPlayed || 0,
      gamesStarted:    g.gamesStarted || 0,
      teamName,
      tier:            _goalieToTier(savePct),
    };

    await cacheSet(cacheKey, result, 2 * 3600); // 2h cache for goalie
    logger.info(`[NHLStatsClient] Starter: ${teamName} → ${name} SV%=${savePct} GAA=${gaa}`);
    return result;

  } catch (err) {
    logger.warn('[NHLStatsClient] getStartingGoalie failed', { teamName, error: err.message });
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _normName(name = '') {
  return String(name).toLowerCase()
    .replace(/[.''\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _goalieToTier(savePct) {
  if (savePct == null) return 'unknown';
  if (savePct >= 0.930) return 'elite';
  if (savePct >= 0.915) return 'above_avg';
  if (savePct >= 0.905) return 'average';
  if (savePct >= 0.890) return 'below_avg';
  return 'weak';
}

module.exports = {
  getTeamRoster,
  resolvePlayerId,
  getPlayerGameLog,
  getTeamStats,
  getStartingGoalie,
  getTeamAbbrev,
  getCurrentSeason,
  TEAM_ABBREV,
};


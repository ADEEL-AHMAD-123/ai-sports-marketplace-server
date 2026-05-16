/**
 * NHLStatsClient.js — Official NHL Stats API client
 *
 * Base: https://api-web.nhle.com/v1
 * No API key required. Free, official, used by NHL.com itself.
 *
 * ENDPOINTS USED:
 *   /roster/{teamAbbrev}/current                            → player IDs for a team
 *   /player/{playerId}/game-log/{season}/{gameType}         → skater/goalie game log
 *   /club-stats/{teamAbbrev}/now                            → team season stats (skaters + goalies)
 *   /club-stats-season/{teamAbbrev}                         → team-wide aggregates per season
 *   /standings/now                                          → team summaries (PP%, PK%) — used by /club-stats fallback
 *
 * SEASON FORMAT: "20242025" (no dash, start year + end year concatenated)
 * GAME TYPE:     2 = regular season, 3 = playoffs
 *
 * CACHING:
 *   Rosters:        24h (rarely changes mid-season)
 *   Game logs:       4h (updated after each game)
 *   Team stats:      6h (slow-changing)
 *   Goalie form:     2h (per-game form needs to refresh quickly)
 *   Player IDs:     30d (player IDs are stable)
 */

const axios  = require('axios');
const { cacheGet, cacheSet } = require('../../../config/redis');
const logger = require('../../../config/logger');

const BASE_URL     = 'https://api-web.nhle.com/v1';
const TIMEOUT_MS   = 10_000;
const HTTP_RETRIES = 2;

// Cache TTLs
const TTL_ROSTER       = 24 * 3600;
const TTL_GAME_LOG     =  4 * 3600;
const TTL_TEAM_STATS   =  6 * 3600;
const TTL_GOALIE_STATS =  2 * 3600;
const TTL_PLAYER_ID    = 30 * 24 * 3600; // 30 days

// ── Team name → NHL 3-letter abbreviation map ────────────────────────────────
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

// Reverse lookup: abbrev → primary full name (last write wins, MTL→Montreal etc.)
const ABBREV_TO_NAME = (() => {
  const out = {};
  for (const [name, abbr] of Object.entries(TEAM_ABBREV)) {
    if (!out[abbr]) out[abbr] = name;
  }
  return out;
})();

// ── Season helpers ────────────────────────────────────────────────────────────

function getCurrentSeason(date = new Date()) {
  const yr  = date.getFullYear();
  const startYear = (date.getMonth() + 1) >= 10 ? yr : yr - 1;
  return `${startYear}${startYear + 1}`;
}

/** Previous season string ("20232024" given current "20242025"). */
function getPreviousSeason(season) {
  const start = parseInt(String(season).slice(0, 4), 10);
  if (!Number.isFinite(start)) return null;
  return `${start - 1}${start}`;
}

// When merged log is below this size we backfill from the prior season.
const BASELINE_BACKFILL_THRESHOLD = 30;
// Sample-size floor for accepting "moderate" data quality.
const SAMPLE_SIZE_FLOOR_FOR_LOW_CONF = 5;

/**
 * Determine NHL game type for a date.
 * Playoffs: typically Apr 19 – Jun 30 (regulation buffer for OT/finals).
 * @returns {2|3} 2 = regular season, 3 = playoffs
 */
function getGameType(date = new Date()) {
  const month = date.getMonth() + 1;
  const day   = date.getDate();
  const isPlayoffs = (month === 4 && day >= 19) || month === 5 || (month === 6 && day <= 30);
  return isPlayoffs ? 3 : 2;
}

function getTeamAbbrev(teamName) {
  if (!teamName) return null;
  if (TEAM_ABBREV[teamName]) return TEAM_ABBREV[teamName];
  // Fuzzy: try lowercase contains on last word (handles "Canadiens"/"Canadiens")
  const lower = teamName.toLowerCase();
  for (const [name, abbrev] of Object.entries(TEAM_ABBREV)) {
    if (lower.includes(name.toLowerCase().split(' ').slice(-1)[0])) return abbrev;
  }
  return null;
}

function _coerceTeamAbbrev(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length === 3) return trimmed.toUpperCase();
  return getTeamAbbrev(trimmed);
}

async function _hydrateCachedResolvedPlayer(cachedPlayer, teams = [], normTarget = null) {
  if (!cachedPlayer || typeof cachedPlayer !== 'object') return null;

  // Backward-compat: older cache payloads may have team/teamName instead of teamAbbrev.
  const explicitTeam =
    _coerceTeamAbbrev(cachedPlayer.teamAbbrev) ||
    _coerceTeamAbbrev(cachedPlayer.team) ||
    _coerceTeamAbbrev(cachedPlayer.teamName) ||
    _coerceTeamAbbrev(cachedPlayer.abbrev);

  if (explicitTeam) {
    return {
      ...cachedPlayer,
      teamAbbrev: explicitTeam,
    };
  }

  const id = Number(cachedPlayer.id);
  if (!Number.isFinite(id)) return cachedPlayer;

  for (const team of teams) {
    const roster = await getTeamRoster(team);
    if (!roster?.size) continue;

    if (normTarget && roster.has(normTarget)) {
      const exact = roster.get(normTarget);
      if (Number(exact?.id) === id) {
        return {
          ...cachedPlayer,
          firstName: cachedPlayer.firstName || exact.firstName,
          lastName: cachedPlayer.lastName || exact.lastName,
          fullName: cachedPlayer.fullName || exact.fullName,
          position: cachedPlayer.position || exact.position,
          teamAbbrev: exact.teamAbbrev,
        };
      }
    }

    for (const [, player] of roster) {
      if (Number(player?.id) !== id) continue;
      return {
        ...cachedPlayer,
        firstName: cachedPlayer.firstName || player.firstName,
        lastName: cachedPlayer.lastName || player.lastName,
        fullName: cachedPlayer.fullName || player.fullName,
        position: cachedPlayer.position || player.position,
        teamAbbrev: player.teamAbbrev,
      };
    }
  }

  return cachedPlayer;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function _get(path) {
  const url = `${BASE_URL}${path}`;
  const isRetryable = (err) => {
    const code = err?.code || err?.cause?.code;
    return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  };

  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt += 1) {
    try {
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
    } catch (err) {
      if (attempt >= HTTP_RETRIES || !isRetryable(err)) throw err;
      const waitMs = 250 * (attempt + 1);
      logger.warn('[NHLStatsClient] transient HTTP error, retrying', {
        path,
        attempt: attempt + 1,
        maxRetries: HTTP_RETRIES,
        code: err?.code || err?.cause?.code || null,
        message: err?.message || 'unknown error',
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return null;
}

// ── Player ID resolution ──────────────────────────────────────────────────────

/**
 * Returns Map<normalizedName, { id, position, firstName, lastName, teamAbbrev }>
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
          id:         p.id,
          position:   p.position,
          firstName:  first,
          lastName:   last,
          fullName:   full,
          teamAbbrev: abbrev,
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
 * Resolve player → { id, position, teamAbbrev, fullName }.
 * Searches both rosters and includes the team that matched.
 *
 * @param {string} playerName
 * @param {string} homeTeamName
 * @param {string} awayTeamName
 * @returns {Promise<{ id, position, teamAbbrev, fullName } | null>}
 */
async function resolvePlayerId(playerName, homeTeamName, awayTeamName) {
  const normTarget = _normName(playerName);
  if (!normTarget) return null;

  const teams = [homeTeamName, awayTeamName].filter(Boolean);

  // Cache key includes both team contexts so we don't pollute across games
  const teamsKey   = teams.map(getTeamAbbrev).filter(Boolean).sort().join('-') || 'any';
  const idCacheKey = `nhl:playerid:${teamsKey}:${normTarget}`;
  const cachedId   = await cacheGet(idCacheKey);
  if (cachedId) {
    const hydrated = await _hydrateCachedResolvedPlayer(cachedId, teams, normTarget);
    if (hydrated?.teamAbbrev && !cachedId.teamAbbrev) {
      await cacheSet(idCacheKey, hydrated, TTL_PLAYER_ID);
    }
    return hydrated;
  }

  const rosters = await Promise.allSettled(teams.map(t => getTeamRoster(t)));

  for (const result of rosters) {
    if (result.status !== 'fulfilled') continue;
    const roster = result.value;

    if (roster.has(normTarget)) {
      const player = roster.get(normTarget);
      await cacheSet(idCacheKey, player, TTL_PLAYER_ID);
      return player;
    }

    // Last-name fallback (handles middle name / suffix differences)
    const lastName = normTarget.split(' ').slice(-1)[0];
    if (lastName && lastName.length >= 3) {
      for (const [key, player] of roster) {
        if (key.endsWith(` ${lastName}`) || key === lastName) {
          await cacheSet(idCacheKey, player, TTL_PLAYER_ID);
          return player;
        }
      }
    }
  }

  logger.debug(`[NHLStatsClient] Player not found: "${playerName}" in ${teams.join(' vs ')}`);
  return null;
}

// ── Player game log ───────────────────────────────────────────────────────────

const _normalizeSkaterLog = (log = [], { gameType = 2, season = null } = {}) =>
  log.map(g => ({
    gameDate:         g.gameDate,
    goals:            g.goals            ?? 0,
    assists:          g.assists          ?? 0,
    points:           g.points           ?? ((g.goals ?? 0) + (g.assists ?? 0)),
    shots:            g.shots            ?? 0,
    shotsOnGoal:      g.shots            ?? 0,
    toi:              g.toi              || '0:00',
    timeOnIce:        g.toi              || '0:00',
    powerPlayGoals:   g.powerPlayGoals   ?? 0,
    powerPlayPoints:  g.powerPlayPoints  ?? 0,
    shortHandedGoals: g.shortHandedGoals ?? 0,
    plusMinus:        g.plusMinus        ?? 0,
    pim:              g.penaltyMinutes   ?? 0,
    gameId:           g.gameId,
    homeRoadFlag:     g.homeRoadFlag     || null,
    opponentAbbrev:   g.opponentAbbrev   || g.opponentTeamAbbrev || null,
    // Provenance — formulas + grader use these to weight + filter.
    gameType:         gameType,           // 2 = regular, 3 = playoff
    isPlayoff:        gameType === 3,
    seasonId:         season,
  }));

const _normalizeGoalieLog = (log = [], { gameType = 2, season = null } = {}) =>
  log.map(g => ({
    gameDate:        g.gameDate,
    decision:        g.decision || null,
    shotsAgainst:    g.shotsAgainst    ?? 0,
    goalsAgainst:    g.goalsAgainst    ?? 0,
    saves:           (g.shotsAgainst ?? 0) - (g.goalsAgainst ?? 0),
    savePctg:        g.savePctg        ?? null,
    toi:             g.toi             || '0:00',
    gameId:          g.gameId,
    homeRoadFlag:    g.homeRoadFlag    || null,
    opponentAbbrev:  g.opponentAbbrev  || null,
    gameType:        gameType,
    isPlayoff:       gameType === 3,
    seasonId:        season,
  }));

/**
 * Sort+merge two logs by gameDate ascending. Stable; ties preserve playoff order.
 */
function _mergeByDate(...logs) {
  const all = [].concat(...logs.filter(Boolean));
  return all.sort((a, b) => {
    const aT = a.gameDate ? +new Date(a.gameDate) : 0;
    const bT = b.gameDate ? +new Date(b.gameDate) : 0;
    return aT - bT;
  });
}

/**
 * Fetch skater game log.
 *
 * IMPROVED LOGIC:
 *   • Always fetch BOTH regular-season and playoff logs for the current season.
 *     Each row is tagged with isPlayoff/gameType/seasonId so formulas can weight
 *     them correctly. This fixes the prior bug where playing in 1 playoff game
 *     would shadow 82 regular-season games.
 *   • If the merged current-season log is below BASELINE_BACKFILL_THRESHOLD
 *     (30 games), pull the prior season's regular-season log and prepend it as
 *     baseline padding. Prior-season rows are still tagged with their seasonId
 *     so formulas can keep them out of FORM/EDGE windows if desired.
 *
 * @param {number} playerId
 * @param {string} [season]
 * @param {Object} [opts]
 * @param {boolean} [opts.skipBackfill]  — set true to disable prior-season padding
 * @returns {Promise<Array>} normalized rows, sorted oldest → newest
 */
async function getPlayerGameLog(playerId, season = null, opts = {}) {
  const s        = season || getCurrentSeason();
  const cacheKey = `nhl:gamelog:${playerId}:${s}:combined:v3`;
  const cached   = await cacheGet(cacheKey);
  if (cached?.length > 0) return cached;

  const fetchByType = async (sn, type) => {
    try {
      const data = await _get(`/player/${playerId}/game-log/${sn}/${type}`);
      return _normalizeSkaterLog(data.gameLog || [], { gameType: type, season: sn });
    } catch (err) {
      // Empty arrays on 404 — player has no games of that type that season.
      const status = err?.response?.status;
      if (status === 404) return [];
      throw err;
    }
  };

  try {
    // Always fetch both regular + playoff for current season — cheap, two parallel requests.
    const [regCurrent, playoffCurrent] = await Promise.all([
      fetchByType(s, 2),
      fetchByType(s, 3),
    ]);

    let merged = _mergeByDate(regCurrent, playoffCurrent);

    // Backfill from prior season when the current season is thin.
    if (!opts.skipBackfill && merged.length < BASELINE_BACKFILL_THRESHOLD) {
      const prev = getPreviousSeason(s);
      if (prev) {
        try {
          const [regPrev, playoffPrev] = await Promise.all([
            fetchByType(prev, 2),
            fetchByType(prev, 3),
          ]);
          const prevMerged = _mergeByDate(regPrev, playoffPrev);
          if (prevMerged.length) {
            // Prepend prior-season rows so the chronological order is preserved.
            merged = _mergeByDate(prevMerged, merged);
            logger.info(`[NHLStatsClient] Backfilled prior-season log: playerId=${playerId} prev=${prevMerged.length} current=${regCurrent.length + playoffCurrent.length}`);
          }
        } catch (e) {
          logger.debug('[NHLStatsClient] Prior-season backfill failed (non-fatal)', { playerId, error: e.message });
        }
      }
    }

    await cacheSet(cacheKey, merged, TTL_GAME_LOG);
    logger.info(
      `[NHLStatsClient] Game log: playerId=${playerId} season=${s} ` +
      `regular=${regCurrent.length} playoff=${playoffCurrent.length} total=${merged.length}`
    );
    return merged;

  } catch (err) {
    logger.warn('[NHLStatsClient] getPlayerGameLog failed', { playerId, error: err.message });
    return [];
  }
}

/**
 * Invalidate a player's game log cache (e.g., after a final-state flip).
 */
async function invalidatePlayerGameLog(playerId, season = null) {
  const s = season || getCurrentSeason();
  const { cacheDel } = require('../../../config/redis');
  await Promise.all([
    cacheDel(`nhl:gamelog:${playerId}:${s}:combined:v3`),
    // Legacy keys (pre-v3 single-type cache) — best-effort cleanup
    cacheDel(`nhl:gamelog:${playerId}:${s}:2`),
    cacheDel(`nhl:gamelog:${playerId}:${s}:3`),
  ]);
}

/**
 * Goalie game log — used for last-N form computation.
 *
 * Like skater logs, we fetch both regular + playoff for the current season
 * and merge by date. Prior-season backfill is OFF by default for goalies
 * because last-5 form is a recency signal — old games shouldn't pollute it.
 *
 * @param {number} playerId
 * @returns {Promise<Array>} normalized goalie rows
 */
async function getGoalieGameLog(playerId, season = null) {
  const s        = season || getCurrentSeason();
  const cacheKey = `nhl:goaliegamelog:${playerId}:${s}:combined:v3`;
  const cached   = await cacheGet(cacheKey);
  if (cached?.length > 0) return cached;

  const fetchByType = async (type) => {
    try {
      const data = await _get(`/player/${playerId}/game-log/${s}/${type}`);
      return _normalizeGoalieLog(data.gameLog || [], { gameType: type, season: s });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) return [];
      throw err;
    }
  };

  try {
    const [regular, playoff] = await Promise.all([fetchByType(2), fetchByType(3)]);
    const merged = _mergeByDate(regular, playoff);
    await cacheSet(cacheKey, merged, TTL_GAME_LOG);
    return merged;
  } catch (err) {
    logger.warn('[NHLStatsClient] getGoalieGameLog failed', { playerId, error: err.message });
    return [];
  }
}

// ── Team stats ────────────────────────────────────────────────────────────────

/**
 * Get team season stats: PP%, PK%, shots-for/against, goals-for/against.
 *
 * @param {string} teamName
 * @returns {Promise<Object|null>}
 */
async function getTeamStats(teamName) {
  const abbrev = getTeamAbbrev(teamName);
  if (!abbrev) return null;

  const cacheKey = `nhl:teamstats:${abbrev}:v3`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await _get(`/club-stats/${abbrev}/now`);

    const skaters = data.skaters || [];
    const goalies = data.goalies || [];

    // Games played: max gp across skaters (some scratched players have GP=0)
    const gp = skaters.reduce((m, s) => Math.max(m, s.gamesPlayed || 0), 0) || 1;

    let totalGoals = 0, totalShots = 0, totalPPGoals = 0;
    for (const s of skaters) {
      totalGoals   += s.goals          ?? 0;
      totalShots   += s.shots          ?? 0;
      totalPPGoals += s.powerPlayGoals ?? 0;
    }

    // Goalie aggregates → goals-against, shots-against (CRITICAL — was null before)
    let totalGA = 0, totalSA = 0;
    for (const g of goalies) {
      totalGA += g.goalsAgainst ?? 0;
      totalSA += g.shotsAgainst ?? 0;
    }

    // Standings endpoint exposes PP%, PK%, GF/GA — try it for extra fields.
    let ppPct = null;
    let pkPct = null;
    let clinchIndicator = null;
    let ppOpportunitiesPerGame = null;
    let pkOpportunitiesPerGame = null;
    try {
      const standings = await _get(`/standings/now`);
      const row = (standings?.standings || []).find(
        r => (r.teamAbbrev?.default || r.teamAbbrev) === abbrev
      );
      if (row) {
        clinchIndicator = row.clinchIndicator || null;
        // Some seasons expose powerPlayPct; if absent we leave null.
        if (Number.isFinite(row.powerPlayPct))     ppPct = parseFloat((row.powerPlayPct * 100).toFixed(1));
        if (Number.isFinite(row.penaltyKillPct))   pkPct = parseFloat((row.penaltyKillPct * 100).toFixed(1));
      }
    } catch {
      /* non-fatal — PP%/PK% remain null and prompt block falls through */
    }

    // Fallback: if standings didn't expose PP%, compute coarse PP% from PPG / shots-for ratio of skaters
    if (ppPct == null && totalGoals > 0) {
      // Heuristic: PP-goal share of total goals tells us PP-dependence, not PP% efficiency.
      // We expose `ppGoalShare` as a secondary signal so consumers can use it.
    }
    const ppGoalSharePct = totalGoals > 0
      ? parseFloat(((totalPPGoals / totalGoals) * 100).toFixed(1))
      : null;

    const result = {
      teamName,
      abbrev,
      clinchIndicator,
      gamesPlayed:             gp,
      ppPct,                   // null if not surfaced by standings
      pkPct,
      ppOpportunitiesPerGame,  // null — endpoint doesn't expose it; left for future feed
      pkOpportunitiesPerGame,
      ppGoalSharePct,          // % of goals scored on PP
      shotsForPerGame:     parseFloat((totalShots / gp).toFixed(1)),
      shotsAgainstPerGame: parseFloat((totalSA    / gp).toFixed(1)),
      goalsForPerGame:     parseFloat((totalGoals / gp).toFixed(2)),
      goalsAgainstPerGame: parseFloat((totalGA    / gp).toFixed(2)),
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
 * Get the season-leading goalie + their season aggregates and recent form.
 *
 * @param {string} teamName
 * @param {Object} [opts]
 * @param {boolean} [opts.includeBackup] — also return the backup goalie (for B2B logic)
 * @returns {Promise<Object|null>}
 */
async function getStartingGoalie(teamName, opts = {}) {
  const cacheKey = `nhl:goalie:${_normName(teamName)}:${getCurrentSeason()}:v2`;
  const cached   = await cacheGet(cacheKey);
  if (cached && !opts.bypassCache) return cached;

  try {
    const abbrev = getTeamAbbrev(teamName);
    if (!abbrev) return null;

    const data    = await _get(`/club-stats/${abbrev}/now`);
    const goalies = data.goalies || [];
    if (!goalies.length) return null;

    // Sort by gamesStarted (preferred), fallback gamesPlayed
    const sorted = [...goalies].sort(
      (a, b) => ((b.gamesStarted ?? b.gamesPlayed) || 0) - ((a.gamesStarted ?? a.gamesPlayed) || 0)
    );

    const buildGoalie = async (g) => {
      const name    = `${g.firstName?.default || ''} ${g.lastName?.default || ''}`.trim();
      const savePct = g.savePercentage != null ? parseFloat(g.savePercentage.toFixed(3)) : null;
      const gaa     = g.goalsAgainstAverage != null ? parseFloat(g.goalsAgainstAverage.toFixed(2)) : null;

      // Recent-form: last 5 starts
      let recentForm = null;
      if (g.playerId) {
        try {
          const log = await getGoalieGameLog(g.playerId);
          const recent = (log || []).slice(-5);
          if (recent.length) {
            const totalSA = recent.reduce((s, r) => s + (r.shotsAgainst || 0), 0);
            const totalGA = recent.reduce((s, r) => s + (r.goalsAgainst || 0), 0);
            const recentSV = totalSA > 0
              ? parseFloat(((totalSA - totalGA) / totalSA).toFixed(3))
              : null;
            recentForm = {
              startsCount:    recent.length,
              recentSavePct:  recentSV,
              recentGAA:      recent.length > 0 ? parseFloat((totalGA / recent.length).toFixed(2)) : null,
              isHot:          recentSV != null && savePct != null && (recentSV - savePct) >= 0.010,
              isCold:         recentSV != null && savePct != null && (savePct - recentSV) >= 0.015,
            };
          }
        } catch (e) {
          /* non-fatal */
        }
      }

      // Effective tier blends season + recent form (cold elite goalie → above_avg, hot avg goalie → above_avg)
      let effectivePct = savePct;
      if (recentForm?.recentSavePct != null && recentForm.startsCount >= 3) {
        // Weighted: 60% season, 40% last-5 (matchup-night model leans on form a bit)
        effectivePct = (savePct ?? recentForm.recentSavePct) != null
          ? parseFloat(((0.6 * (savePct ?? recentForm.recentSavePct)) + (0.4 * recentForm.recentSavePct)).toFixed(3))
          : null;
      }

      return {
        name,
        id:              g.playerId,
        savePercentage:  savePct,
        goalsAgainstAvg: gaa,
        gamesPlayed:     g.gamesPlayed || 0,
        gamesStarted:    g.gamesStarted || 0,
        teamName,
        teamAbbrev:      abbrev,
        tier:            _goalieToTier(effectivePct),
        seasonTier:      _goalieToTier(savePct),
        effectiveSavePct: effectivePct,
        recentForm,
      };
    };

    const starter = await buildGoalie(sorted[0]);
    const backup  = sorted[1] ? await buildGoalie(sorted[1]) : null;

    const result = opts.includeBackup ? { ...starter, backup } : starter;
    await cacheSet(cacheKey, result, TTL_GOALIE_STATS);
    logger.info(`[NHLStatsClient] Starter: ${teamName} → ${starter.name} SV%=${starter.savePercentage} (recent SV%=${starter.recentForm?.recentSavePct ?? 'n/a'})`);
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
  // Core
  getTeamRoster,
  resolvePlayerId,
  getPlayerGameLog,
  getGoalieGameLog,
  invalidatePlayerGameLog,
  getTeamStats,
  getStartingGoalie,
  // Utilities
  getTeamAbbrev,
  getCurrentSeason,
  getPreviousSeason,
  getGameType,
  normName: _normName,
  TEAM_ABBREV,
  ABBREV_TO_NAME,
  // Constants exposed for formulas
  BASELINE_BACKFILL_THRESHOLD,
  SAMPLE_SIZE_FLOOR_FOR_LOW_CONF,
};

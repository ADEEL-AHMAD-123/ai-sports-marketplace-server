/**
 * playerResolver.js — Player name → API-Sports ID resolver
 *
 * FIXES IN THIS VERSION:
 *  1. Full API response logging — you can see exactly what the API returns
 *     including errors, quota status, and raw player list
 *  2. Backward compatible: accepts both string[] and {playerName, teamApiSportsId}[]
 *  3. Correct sport-specific base URLs and league IDs
 *  4. Graceful handling of quota exhaustion (returns null instead of crashing)
 */

const axios    = require('axios');
const mongoose = require('mongoose');
const logger   = require('../config/logger');

// ─── Cache schema ─────────────────────────────────────────────────────────────
const playerCacheSchema = new mongoose.Schema(
  {
    oddsApiName:   { type: String, required: true, index: true },
    sport:         { type: String, required: true, index: true },
    apiSportsId:   { type: Number, required: true },
    apiSportsName: { type: String },
    teamName:      { type: String },
  },
  { timestamps: true }
);
playerCacheSchema.index({ oddsApiName: 1, sport: 1 }, { unique: true });
const PlayerCache = mongoose.models.PlayerCache || mongoose.model('PlayerCache', playerCacheSchema);

// ─── Sport API configs ─────────────────────────────────────────────────────────
// IMPORTANT: API-Sports uses ONE key for ALL sports.
// The key you have for NBA (API_NBA_KEY) works for baseball, hockey, etc.
//
// requiresTeam: true  = NBA v2 — team param is MANDATORY, name-only search errors
// requiresTeam: false = MLB v1, NHL — team param is optional, name search works alone
const SPORT_CONFIG = {
  nba: {
    baseUrl:      process.env.API_NBA_BASE_URL || 'https://v2.nba.api-sports.io',
    leagueId:     12,
    requiresTeam: true,   // NBA v2 API REQUIRES team param — name-only returns error
    season: () => {
      const now = new Date();
      const yr  = now.getFullYear();
      return (now.getMonth() + 1) >= 10 ? yr : yr - 1;
    },
  },
  mlb: {
    baseUrl:      process.env.API_MLB_BASE_URL || 'https://v1.baseball.api-sports.io',
    leagueId:     1,
    requiresTeam: false,  // MLB v1 — team is optional, search by name works fine
    season: () => new Date().getFullYear(),
  },
  nhl: {
    baseUrl:      process.env.API_NHL_BASE_URL || 'https://v1.hockey.api-sports.io',
    leagueId:     57,
    requiresTeam: false,
    season: () => {
      const now = new Date();
      const yr  = now.getFullYear();
      return (now.getMonth() + 1) >= 10 ? yr : yr - 1;
    },
  },
  nfl: {
    baseUrl:      process.env.API_NFL_BASE_URL || 'https://v1.american-football.api-sports.io',
    leagueId:     1,
    requiresTeam: false,
    season: () => new Date().getFullYear(),
  },
};

// One key covers all sports — API_SPORTS_KEY takes priority, NBA key as fallback
const getApiKey = () => process.env.API_SPORTS_KEY || process.env.API_NBA_KEY || null;

const NAME_SUFFIXES = new Set(['jr','sr','ii','iii','iv','v']);

// Manual overrides: { 'player name': { sport: playerId } }
// Add here when a player consistently fails auto-resolution
const MANUAL_OVERRIDES = (() => {
  try { return JSON.parse(process.env.PLAYER_ID_OVERRIDES_JSON || '{}'); }
  catch { return {}; }
})();

// ─── Main resolver ────────────────────────────────────────────────────────────

const resolvePlayerId = async (playerName, sport, teamId = null, awayTeamId = null) => {
  if (!playerName || !sport) return null;

  const norm = _normalize(playerName);

  const override = MANUAL_OVERRIDES[norm]?.[sport];
  if (override) return override;

  const cached = await PlayerCache.findOne({ oddsApiName: norm, sport }).lean();
  if (cached) {
    logger.debug(`[PlayerResolver] Cache HIT: "${playerName}" → ${cached.apiSportsId}`);
    return cached.apiSportsId;
  }

  logger.info(`[PlayerResolver] Resolving: "${playerName}" (${sport}, team=${teamId})`);

  const result = await _searchApiSports(playerName, sport, teamId, awayTeamId);
  if (!result) {
    logger.warn(`[PlayerResolver] Could not resolve: "${playerName}" (${sport})`);
    return null;
  }

  try {
    await PlayerCache.create({
      oddsApiName:   norm,
      sport,
      apiSportsId:   result.id,
      apiSportsName: result.name,
      teamName:      result.teamName,
    });
    logger.info(`[PlayerResolver] Cached: "${playerName}" → ${result.id} (${result.name})`);
  } catch (err) {
    if (err.code !== 11000) logger.error('[PlayerResolver] Cache write failed', { error: err.message });
  }

  return result.id;
};

// ─── API search with FULL diagnostic logging ──────────────────────────────────

const _searchApiSports = async (playerName, sport, teamId = null, awayTeamId = null) => {
  const cfg    = SPORT_CONFIG[sport];
  const apiKey = getApiKey();

  if (!cfg)    { logger.warn(`[PlayerResolver] No config for sport: ${sport}`); return null; }
  if (!apiKey) { logger.error('[PlayerResolver] No API key. Set API_SPORTS_KEY or API_NBA_KEY in .env'); return null; }

  const season  = cfg.season();
  const queries = _buildQueries(playerName);

  // Build list of team IDs to try based on sport requirements:
  //   NBA v2: team is REQUIRED — try homeTeam, then awayTeam
  //   MLB v1: team is OPTIONAL — try without team first (cleaner results), team as fallback
  const teamIdsToTry = cfg.requiresTeam
    ? [teamId, awayTeamId].filter(Boolean)   // NBA: must have a team ID
    : [null, teamId, awayTeamId].filter((v, i, arr) => i === 0 || Boolean(v)); // MLB: try null first

  // If requiresTeam and no team IDs available, log and skip
  if (cfg.requiresTeam && teamIdsToTry.length === 0) {
    logger.warn(`[PlayerResolver] ${sport} requires team param but no team IDs available for "${playerName}"`);
    return null;
  }

  for (const tryTeamId of teamIdsToTry) {
    let sawEmptySearchResponses = false;

    for (const query of queries) {
      try {
        const params = { search: query };
        if (tryTeamId) params.team   = tryTeamId;
        if (season)    params.season = season;

        const url = `${cfg.baseUrl}/players`;
        const res = await axios.get(url, {
          headers: { 'x-apisports-key': apiKey },
          params,
          timeout: 8000,
        });

        const errors    = res.data?.errors;
        const players   = res.data?.response || [];
        const quotaLeft = res.headers?.['x-ratelimit-requests-remaining'];

        // Log meaningful responses
        if (players.length > 0) {
          logger.info(`[PlayerResolver] Found ${players.length} results for "${query}"`, {
            sport, team: tryTeamId, quotaRemaining: quotaLeft,
            samplePlayer: `${players[0].firstname} ${players[0].lastname} (id:${players[0].id})`,
          });
        }

        // Team-required error → try next team ID
        if (errors?.team) {
          logger.debug(`[PlayerResolver] team required error for "${query}", trying next team`, { sport });
          break; // break inner query loop, try next teamId
        }

        // Other API errors → stop entirely
        if (errors && Object.keys(errors).filter(k => k !== 'team').length > 0) {
          const nonTeamErrors = Object.fromEntries(
            Object.entries(errors).filter(([k]) => k !== 'team')
          );
          logger.error('[PlayerResolver] API error', { errors: nonTeamErrors, sport, query });
          // Search field error (special chars) — try next query, not fatal
          if (errors.search) continue;
          return null;
        }

        if (!players.length) {
          sawEmptySearchResponses = true;
          continue;
        }

        const best = _bestMatch(playerName, players);
        if (best) {
          return {
            id:       best.id,
            name:     `${best.firstname} ${best.lastname}`,
            teamName: best.team?.name || best.leagues?.standard?.team?.name || '',
          };
        }
      } catch (err) {
        const status = err.response?.status;
        logger.error('[PlayerResolver] HTTP error', {
          query, sport, httpStatus: status, message: err.message,
        });
        if (status === 401) return null;
      }
    }

    // NBA API can return 0 results for `search` even when player exists.
    // Fallback: pull team roster and match locally.
    if (sport === 'nba' && tryTeamId && sawEmptySearchResponses) {
      try {
        const rosterRes = await axios.get(`${cfg.baseUrl}/players`, {
          headers: { 'x-apisports-key': apiKey },
          params: { team: tryTeamId, season },
          timeout: 8000,
        });

        const roster = rosterRes.data?.response || [];
        if (roster.length > 0) {
          const best = _bestMatch(playerName, roster);
          if (best) {
            logger.info('[PlayerResolver] Resolved via team roster fallback', {
              playerName,
              sport,
              team: tryTeamId,
              resolvedId: best.id,
            });
            return {
              id: best.id,
              name: `${best.firstname} ${best.lastname}`,
              teamName: best.team?.name || best.leagues?.standard?.team?.name || '',
            };
          }
        }
      } catch (err) {
        logger.error('[PlayerResolver] Team roster fallback failed', {
          sport,
          team: tryTeamId,
          message: err.message,
        });
      }
    }
  }

  return null;
};

// ─── Bulk resolver ────────────────────────────────────────────────────────────

/**
 * Bulk resolve player IDs.
 * Supports both old format (string[]) and new format ({playerName, teamApiSportsId}[]).
 *
 * @param {string[]|Object[]} players
 * @param {string} sport
 */
const bulkResolvePlayerIds = async (players, sport) => {
  const results = new Map();

  const normalized = players.map(p =>
    typeof p === 'string'
      ? { playerName: p, teamApiSportsId: null, awayTeamApiSportsId: null }
      : {
          playerName:          p.playerName,
          teamApiSportsId:     p.teamApiSportsId     || null,
          awayTeamApiSportsId: p.awayTeamApiSportsId || null,
        }
  );

  const batchSize = 5;
  for (let i = 0; i < normalized.length; i += batchSize) {
    const batch = normalized.slice(i, i + batchSize);
    await Promise.all(batch.map(async ({ playerName, teamApiSportsId, awayTeamApiSportsId }) => {
      const id = await resolvePlayerId(playerName, sport, teamApiSportsId, awayTeamApiSportsId);
      if (id) results.set(playerName, id);
    }));
    if (i + batchSize < normalized.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  logger.info(`[PlayerResolver] Resolved ${results.size}/${normalized.length}`, { sport });
  return results;
};

// ─── Matching helpers ─────────────────────────────────────────────────────────

const _bestMatch = (targetName, players) => {
  const normTarget = _normalize(_stripSuffixes(targetName));
  const parts      = normTarget.split(' ').filter(Boolean);
  const tFirst     = parts[0] || '';
  const tLast      = parts.slice(1).join(' ') || parts[0] || '';
  const tLastTokens = new Set(tLast.split(' ').filter(Boolean));
  const tAllTokens = new Set(normTarget.split(' ').filter(Boolean));

  let bestScore = 0;
  let best      = null;

  for (const p of players) {
    const pFirst = _normalize(p.firstname || '');
    const pLast  = _normalize(_stripSuffixes(p.lastname || ''));
    const full   = `${pFirst} ${pLast}`.trim();

    if (full === normTarget) return p;

    const pAllTokens = new Set(full.split(' ').filter(Boolean));
    const sameFullTokenSet =
      tAllTokens.size > 0 &&
      tAllTokens.size === pAllTokens.size &&
      [...tAllTokens].every((tok) => pAllTokens.has(tok));

    // Handle provider quirks where compound surnames are split between first/last.
    if (sameFullTokenSet) return p;

    let lastSim  = _dice(tLast, pLast);
    const pLastTokens = new Set(pLast.split(' ').filter(Boolean));
    const sameLastTokenSet =
      tLastTokens.size > 0 &&
      tLastTokens.size === pLastTokens.size &&
      [...tLastTokens].every((tok) => pLastTokens.has(tok));

    // Handle surname token order variants like "da silva" vs "silva da".
    if (sameLastTokenSet) {
      lastSim = Math.max(lastSim, 0.9);
    }

    if (lastSim < 0.70) continue;

    const firstSim = _firstSim(tFirst, pFirst);
    const score    = lastSim * 0.4 + firstSim * 0.6;

    if (score > bestScore) { bestScore = score; best = p; }
  }

  return bestScore >= 0.75 ? best : null;
};

const _firstSim = (a, b) => {
  if (!a || !b) return 0;
  if (a === b)  return 1;
  if (a[0] === b[0] && (a.length <= 2 || b.length <= 2)) return 0.9;
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  if (longer.startsWith(shorter) && shorter.length >= 3) return 0.92;
  return _dice(a, b);
};

const _dice = (a, b) => {
  if (a === b) return 1;
  if (!a || !b || a.length < 2 || b.length < 2) return 0;
  const bg = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i+2);
      m.set(k, (m.get(k)||0) + 1);
    }
    return m;
  };
  const ab = bg(a), bb = bg(b);
  let ix = 0;
  for (const [k,v] of ab) ix += Math.min(v, bb.get(k)||0);
  return (2 * ix) / (a.length - 1 + b.length - 1);
};

const _normalize  = (s) => String(s||'').toLowerCase().replace(/['.]/g,'').replace(/\s+/g,' ').trim();
const _stripSuffixes = (s) => {
  const parts = _normalize(s).split(' ').filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length-1])) parts.pop();
  return parts.join(' ');
};

const _buildQueries = (name) => {
  const orig     = String(name||'').trim();
  const stripped = _stripSuffixes(orig);
  const parts    = stripped.split(' ').filter(Boolean);
  const queries  = new Set();

  // API-Sports v2 only allows alphanumeric + spaces in search
  // Strip hyphens, apostrophes, dots, special chars
  const clean = (s) => s.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (orig)               queries.add(clean(orig));
  if (stripped !== orig)  queries.add(clean(stripped));
  // Also try just first + last name (handles "Jr.", "II" etc already handled by _stripSuffixes)
  if (parts.length >= 2)  queries.add(clean(parts.slice(1).join(' '))); // last name
  if (parts.length >= 2)  queries.add(clean(parts[0] + ' ' + parts[parts.length-1])); // first + last only

  return [...queries].filter(q => q.length >= 2);
};

module.exports = { resolvePlayerId, bulkResolvePlayerIds, PlayerCache };
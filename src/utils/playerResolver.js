/**
 * playerResolver.js — Player name → API-Sports ID resolver
 *
 * THE PROBLEM:
 *  The Odds API uses player names like "LeBron James"
 *  API-Sports uses numeric player IDs like 265
 *  We need to link them so we can fetch the right player's stats.
 *
 * THE SOLUTION (3-layer lookup):
 *  Layer 1: MongoDB cache — check if we've already resolved this player
 *  Layer 2: API-Sports search — search by name, pick best match
 *  Layer 3: Fuzzy fallback — handle name variations (e.g. "PJ Tucker" vs "P.J. Tucker")
 *
 * Results are cached in MongoDB permanently (player IDs don't change).
 * This means we only call the API-Sports search endpoint ONCE per player ever.
 *
 * Usage:
 *   const { resolvePlayerId } = require('./playerResolver');
 *   const playerId = await resolvePlayerId('LeBron James', 'nba');
 */

const axios = require('axios');
const mongoose = require('mongoose');
const logger = require('../config/logger');

// ─── PlayerCache schema (stored in MongoDB permanently) ───────────────────────
// Separate lightweight collection just for name→ID mappings
const playerCacheSchema = new mongoose.Schema(
  {
    // The name as it appears in The Odds API (e.g., "LeBron James")
    oddsApiName: {
      type: String,
      required: true,
      index: true,
    },
    // The sport this player belongs to
    sport: {
      type: String,
      required: true,
      index: true,
    },
    // Resolved API-Sports player ID
    apiSportsId: {
      type: Number,
      required: true,
    },
    // Full name from API-Sports (for verification)
    apiSportsName: {
      type: String,
    },
    // Team name from API-Sports (for disambiguation when two players share a name)
    teamName: {
      type: String,
    },
  },
  { timestamps: true }
);

// Unique index: one mapping per player name per sport
playerCacheSchema.index({ oddsApiName: 1, sport: 1 }, { unique: true });

// Create the model only once (Mongoose will throw if registered twice during hot reload)
const PlayerCache = mongoose.models.PlayerCache ||
  mongoose.model('PlayerCache', playerCacheSchema);

// ─── Sport-specific API-Sports league IDs ─────────────────────────────────────
// Used in search queries to narrow results to the correct league
const LEAGUE_IDS = {
  nba: 12,    // NBA
  nfl: 1,     // NFL (API-Sports American Football)
  mlb: 1,     // MLB (API-Sports Baseball)
  nhl: 57,    // NHL (API-Sports Hockey)
};

/**
 * Resolve a player name to their API-Sports ID.
 * Uses MongoDB cache first, then API-Sports search.
 *
 * @param {string} playerName - Name from The Odds API (e.g., "LeBron James")
 * @param {string} sport      - Sport key (e.g., 'nba')
 * @returns {Promise<number|null>} API-Sports player ID, or null if not found
 */
const resolvePlayerId = async (playerName, sport) => {
  if (!playerName || !sport) return null;

  const normalizedName = _normalizeName(playerName);

  // ── Layer 1: Check MongoDB cache ─────────────────────────────────────────
  const cached = await PlayerCache.findOne({
    oddsApiName: normalizedName,
    sport,
  }).lean();

  if (cached) {
    logger.debug(`[PlayerResolver] Cache HIT: "${playerName}" → ${cached.apiSportsId}`);
    return cached.apiSportsId;
  }

  logger.info(`[PlayerResolver] Cache MISS — searching API-Sports for: "${playerName}"`, { sport });

  // ── Layer 2: API-Sports search ────────────────────────────────────────────
  const result = await _searchApiSports(playerName, sport);

  if (!result) {
    logger.warn(`[PlayerResolver] Could not resolve player: "${playerName}"`, { sport });
    return null;
  }

  // ── Store in cache for future lookups ─────────────────────────────────────
  try {
    await PlayerCache.create({
      oddsApiName: normalizedName,
      sport,
      apiSportsId: result.id,
      apiSportsName: result.name,
      teamName: result.teamName,
    });

    logger.info(`[PlayerResolver] Resolved and cached: "${playerName}" → ${result.id}`, {
      sport,
      apiSportsName: result.name,
    });
  } catch (cacheErr) {
    // Duplicate key error means another request already cached it — safe to ignore
    if (cacheErr.code !== 11000) {
      logger.error('[PlayerResolver] Failed to cache player mapping', { error: cacheErr.message });
    }
  }

  return result.id;
};

/**
 * Search API-Sports for a player by name.
 * Uses fuzzy matching to handle name variations.
 *
 * @param {string} playerName
 * @param {string} sport
 * @returns {Promise<{ id: number, name: string, teamName: string }|null>}
 */
const _searchApiSports = async (playerName, sport) => {
  try {
    // NBA uses the Basketball API endpoint
    // Other sports will use different base URLs — add them as sports are implemented
    const baseUrls = {
      nba: process.env.API_SPORTS_BASE_URL || 'https://v1.basketball.api-sports.io',
    };

    const baseUrl = baseUrls[sport];
    if (!baseUrl) {
      logger.warn(`[PlayerResolver] No API-Sports URL configured for sport: ${sport}`);
      return null;
    }

    const response = await axios.get(`${baseUrl}/players`, {
      headers: { 'x-apisports-key': process.env.API_SPORTS_KEY },
      params: {
        search: playerName,
        league: LEAGUE_IDS[sport],
        season: _getCurrentSeason(sport),
      },
      timeout: 8000,
    });

    const players = response.data?.response || [];

    if (players.length === 0) {
      // Try again with just the last name (some APIs index by last name)
      const lastName = playerName.split(' ').pop();
      if (lastName !== playerName) {
        return _searchApiSports(lastName, sport);
      }
      return null;
    }

    // ── Pick best match ────────────────────────────────────────────────────
    // If multiple results, pick the one whose name most closely matches
    const best = _findBestMatch(playerName, players);
    if (!best) return null;

    return {
      id: best.id,
      name: `${best.firstname} ${best.lastname}`,
      teamName: best.leagues?.standard?.team?.name || '',
    };
  } catch (err) {
    logger.error('[PlayerResolver] API-Sports search failed', {
      playerName,
      sport,
      error: err.message,
      status: err.response?.status,
    });
    return null;
  }
};

/**
 * Find the best matching player from a list of API-Sports results.
 * Uses simple character-level similarity scoring.
 *
 * @param {string} targetName - Name we're looking for
 * @param {Array}  players    - API-Sports player list
 * @returns {Object|null} Best matching player object
 */
const _findBestMatch = (targetName, players) => {
  const normalized = _normalizeName(targetName);
  let bestScore = 0;
  let bestPlayer = null;

  for (const player of players) {
    const fullName = _normalizeName(`${player.firstname} ${player.lastname}`);
    const score = _similarityScore(normalized, fullName);

    if (score > bestScore) {
      bestScore = score;
      bestPlayer = player;
    }
  }

  // Only accept matches with >70% similarity to avoid wrong player IDs
  return bestScore > 0.7 ? bestPlayer : null;
};

/**
 * Simple similarity score between two strings (0–1).
 * Uses character overlap — good enough for name matching.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0 = no match, 1 = exact match
 */
const _similarityScore = (a, b) => {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Check if one contains the other (handles "PJ" vs "P.J.")
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Count matching characters
  const aChars = new Set(a.split(''));
  const bChars = new Set(b.split(''));
  const intersection = [...aChars].filter((c) => bChars.has(c)).length;
  const union = new Set([...aChars, ...bChars]).size;

  return intersection / union;
};

/**
 * Normalize a player name for consistent comparison.
 * Removes punctuation, extra spaces, and lowercases.
 *
 * Examples:
 *  "P.J. Tucker" → "pj tucker"
 *  "LeBron James" → "lebron james"
 *  "De'Aaron Fox" → "deaaron fox"
 *
 * @param {string} name
 * @returns {string}
 */
const _normalizeName = (name) => {
  return name
    .toLowerCase()
    .replace(/['.]/g, '')    // Remove apostrophes and dots
    .replace(/\s+/g, ' ')   // Collapse multiple spaces
    .trim();
};

/**
 * Get the current season string for API-Sports.
 * NBA seasons run October → June: "2024-2025"
 * Adjust per sport as needed.
 *
 * @param {string} sport
 * @returns {string}
 */
const _getCurrentSeason = (sport) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based

  // NBA season starts in October
  // If current month is Oct–Dec, season is "year-(year+1)"
  // If current month is Jan–Jun, season is "(year-1)-year"
  if (sport === 'nba') {
    // API-Sports Basketball uses just the start year: 2025 = 2025-26 season
    return month >= 10 ? String(year) : String(year - 1);
  }

  // Default: use current year
  return String(year);
};

/**
 * Bulk resolve player IDs for a list of player names.
 * Useful when the Prop Watcher fetches props and wants to pre-resolve all player IDs.
 *
 * @param {string[]} playerNames
 * @param {string} sport
 * @returns {Promise<Map<string, number>>} Map of playerName → apiSportsId
 */
const bulkResolvePlayerIds = async (playerNames, sport) => {
  const results = new Map();

  // Process in batches of 5 to avoid rate limiting the API-Sports search endpoint
  const batchSize = 5;
  for (let i = 0; i < playerNames.length; i += batchSize) {
    const batch = playerNames.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (name) => {
        const id = await resolvePlayerId(name, sport);
        if (id) results.set(name, id);
      })
    );

    // Small delay between batches to be a good API citizen
    if (i + batchSize < playerNames.length) {
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  logger.info(`[PlayerResolver] Bulk resolved ${results.size}/${playerNames.length} players`, { sport });
  return results;
};

module.exports = { resolvePlayerId, bulkResolvePlayerIds, PlayerCache };
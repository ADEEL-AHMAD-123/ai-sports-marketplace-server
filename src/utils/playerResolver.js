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

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const PLAYER_ID_OVERRIDES = (() => {
  try {
    const raw = process.env.PLAYER_ID_OVERRIDES_JSON || '{}';
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logger.warn('[PlayerResolver] Invalid PLAYER_ID_OVERRIDES_JSON; expected JSON object');
    return {};
  }
})();

// Manual aliases for known provider naming quirks.
// Keys are normalized odds names; values are extra search queries to try.
const PLAYER_SEARCH_ALIASES = {
  'wendell carter jr': ['wendell carter', 'carter'],
  'derrick jones': ['derrick jones jr', 'jones'],
  'kelly oubre jr': ['kelly oubre', 'oubre'],
  'vj edgecombe': ['edgecombe', 'v edgecombe'],
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

  // Optional manual override for provider gaps or known naming mismatches.
  // Example:
  // PLAYER_ID_OVERRIDES_JSON={"tristan da silva":1234}
  const overrideId = PLAYER_ID_OVERRIDES[normalizedName];
  if (sport === 'nba' && Number.isInteger(overrideId) && overrideId > 0) {
    await PlayerCache.findOneAndUpdate(
      { oddsApiName: normalizedName, sport },
      {
        $set: {
          apiSportsId: overrideId,
          apiSportsName: `override:${playerName}`,
          teamName: '',
        },
      },
      { upsert: true, new: true }
    );
    logger.info(`[PlayerResolver] Using manual override for "${playerName}" → ${overrideId}`);
    return overrideId;
  }

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
    // Always use the single NBA API key and base URL from .env
    // API_NBA_BASE_URL = https://v2.nba.api-sports.io
    // API_NBA_KEY      = your key
    // These are the only sport APIs configured right now.
    const baseUrl = process.env.API_NBA_BASE_URL

      || 'https://v2.nba.api-sports.io';

    const apiKey = process.env.API_NBA_KEY;

    if (!apiKey) {
      logger.warn('[PlayerResolver] No API key found — set API_NBA_KEY in .env');
      return null;
    }

    // NBA v2 player search is performed via `search` only.
    // Keep lookup broad here and let name matching choose the best candidate.

    const trySearch = async (nameParam) => {
      const res = await axios.get(`${baseUrl}/players`, {
        headers: { 'x-apisports-key': apiKey },
        params: { search: nameParam },
        timeout: 8000,
      });

      // Log the raw response for debugging if empty
      const players = res.data?.response || [];
      if (players.length === 0) {
        logger.debug('[PlayerResolver] API returned 0 players', {
          nameParam,
          status:  res.status,
          errors:  res.data?.errors,
          results: res.data?.results,
        });
      }
      return players;
    };

    const queries = _buildSearchQueries(playerName);

    let players = [];
    for (const query of queries) {
      players = await trySearch(query);
      if (players.length > 0) {
        if (query !== playerName) {
          logger.debug(`[PlayerResolver] Resolved using fallback query: "${query}"`, { playerName });
        }
        break;
      }
    }

    if (players.length === 0) return null;

    // ── Pick best match ────────────────────────────────────────────────────
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
  const normTarget   = _normalizeName(_stripNameSuffixes(targetName));
  const targetParts  = normTarget.split(' ').filter(Boolean);
  const targetFirst  = targetParts[0] || '';
  const targetLast   = targetParts.slice(1).join(' ') || '';

  let bestScore  = 0;
  let bestPlayer = null;

  for (const player of players) {
    const normFirst = _normalizeName(player.firstname || '');
    const normLast  = _normalizeName(_stripNameSuffixes(player.lastname || ''));
    const fullName  = `${normFirst} ${normLast}`.trim();

    // ── Scoring rules ───────────────────────────────────────────────────────
    // Rule 1: Exact full name match → perfect score
    if (fullName === normTarget) {
      return player; // Can't do better — return immediately
    }

    // Rule 2: Last name must match closely — this is the hard gate.
    // "Stephen Curry" vs "Seth Curry": last names both "curry" → pass gate
    // "Draymond Green" vs "Danny Green": last names both "green" → pass gate
    // But then first name decides — "draymond" vs "danny" → very different → reject
    const lastSim = _stringSimilarity(targetLast, normLast);
    if (lastSim < 0.75) continue; // Last name doesn't match closely enough — skip

    // Rule 3: First name must match — this is the key fix.
    // Previous code used character set overlap which let "seth" ≈ "stephen".
    // Now we require the first name to START with the same characters or match closely.
    const firstSim = _firstNameSimilarity(targetFirst, normFirst);

    // Combined score: last name is critical (weight 0.4) but first name must also match (weight 0.6)
    const score = (lastSim * 0.4) + (firstSim * 0.6);

    if (score > bestScore) {
      bestScore  = score;
      bestPlayer = player;
    }
  }

  // Require a high overall score — both names must match well
  if (bestScore >= 0.75) {
    return bestPlayer;
  }

  // If no good match found, log it so we can debug
  logger.debug('[PlayerResolver] No confident match found', {
    targetName,
    bestScore: bestScore.toFixed(2),
    candidates: players.slice(0, 3).map(p => `${p.firstname} ${p.lastname}`),
  });

  return null;
};

/**
 * First name similarity — stricter than general string similarity.
 * Requires the first name to start with the same characters.
 * "Stephen" vs "Seth": both start with "s" but diverge quickly → low score
 * "Stephen" vs "Steph":  → high score (nickname match)
 * "Draymond" vs "Danny": start with "d" but very different → low score
 */
const _firstNameSimilarity = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Handle initials and abbreviated first names from API (e.g. "V." vs "VJ")
  if (a[0] === b[0] && (a.length <= 2 || b.length <= 2)) return 0.9;

  // Exact prefix match (handles nicknames): "steph" matches "stephen"
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  if (longer.startsWith(shorter) && shorter.length >= 3) return 0.92;

  // Full string similarity for other cases
  return _stringSimilarity(a, b);
};

/**
 * String similarity using Dice coefficient (bigram overlap).
 * More accurate than character set overlap — respects character order.
 * "draymond" vs "danny": low bigram overlap → low score ✓
 * "stephen" vs "seth":   low bigram overlap → low score ✓
 * "stephen" vs "stephen": 1.0 ✓
 */
const _stringSimilarity = (a, b) => {
  if (a === b) return 1;
  if (!a || !b || a.length < 2 || b.length < 2) return 0;

  // Build bigrams (pairs of adjacent characters)
  const bigrams = (str) => {
    const result = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      result.set(bg, (result.get(bg) || 0) + 1);
    }
    return result;
  };

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);

  let intersection = 0;
  for (const [bg, count] of aBigrams) {
    intersection += Math.min(count, bBigrams.get(bg) || 0);
  }

  const totalA = a.length - 1;
  const totalB = b.length - 1;

  return (2 * intersection) / (totalA + totalB);
};

// Keep old _similarityScore as alias for any other uses
const _similarityScore = _stringSimilarity;

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
 * Remove suffix tokens like Jr/Sr/III from a name for matching/search fallback.
 * Keeps core name stable across data providers that include or omit suffixes.
 *
 * @param {string} name
 * @returns {string}
 */
const _stripNameSuffixes = (name) => {
  const parts = _normalizeName(name).split(' ').filter(Boolean);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(' ');
};

/**
 * Build search variants for API-Sports v2 player lookup.
 *
 * @param {string} name
 * @returns {string[]}
 */
const _buildSearchQueries = (name) => {
  const original = String(name || '').trim();
  const stripped = _stripNameSuffixes(original);
  const normalized = _normalizeName(original);
  const parts = stripped.split(' ').filter(Boolean);
  const queries = new Set();

  const aliases = PLAYER_SEARCH_ALIASES[normalized] || [];
  for (const alias of aliases) queries.add(alias);

  if (original) queries.add(original);
  if (stripped) queries.add(stripped);

  if (parts.length >= 2) {
    queries.add(parts.slice(1).join(' '));   // full last-name segment (e.g. "da silva")
    queries.add(parts[parts.length - 1]);    // final token fallback (e.g. "silva")
  }

  return [...queries].filter(Boolean);
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
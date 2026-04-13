/**
 * odds.controller.js — Games and player props endpoints
 *
 * Handles:
 *  GET /api/odds/sports            — List supported sports
 *  GET /api/odds/:sport/games      — List today's games for a sport
 *  GET /api/odds/:sport/games/:eventId/props — List props for a game
 *
 * Public routes (no auth required) — guest users can browse games and blurred props.
 * Uses Redis HOT cache for fast responses.
 */

const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const { cacheGet, cacheSet } = require('../config/redis');
const { SPORTS, SPORT_LABELS, ACTIVE_SPORTS, CACHE_TTL, CACHE_KEYS, HTTP_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// ─── List Sports ───────────────────────────────────────────────────────────────

/**
 * GET /api/odds/sports
 * Returns the list of available sports with their status (active/coming soon).
 */
const getSports = (req, res) => {
  const sports = Object.values(SPORTS).map((sport) => ({
    key: sport,
    label: SPORT_LABELS[sport],
    isActive: ACTIVE_SPORTS.includes(sport),
    status: ACTIVE_SPORTS.includes(sport) ? 'active' : 'coming_soon',
  }));

  res.status(HTTP_STATUS.OK).json({ success: true, sports });
};

// ─── Get Games ─────────────────────────────────────────────────────────────────

/**
 * GET /api/odds/:sport/games
 * Returns today's games for a sport.
 * Cached in Redis (HOT layer) with CACHE_TTL.SCHEDULE TTL.
 */
const getGames = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const cacheKey = `${CACHE_KEYS.SCHEDULE}:${sport}:${_getTodayKey()}`;

    // ── Check Redis cache ──────────────────────────────────────────────────
    const cached = await cacheGet(cacheKey);
    if (cached) {
      logger.debug(`⚡ [OddsController] Cache HIT — games for ${sport}`);
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        source: 'cache',
        data: cached, // Already enriched when cached
      });
    }

    // ── Query MongoDB ──────────────────────────────────────────────────────
    // Broad time window: 6h ago → 48h ahead (handles timezones & late games)
    const now         = new Date();
    const windowStart = new Date(now.getTime() - 3  * 60 * 60 * 1000); // 3h ago covers live games
    const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h ahead = 3 days of schedule

    let games = await Game.find({
      sport,
      startTime: { $gte: windowStart, $lte: windowEnd },
      status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
    })
      .sort({ startTime: 1 })
      .select('-__v')
      .lean();

    // Safety fallback: if status filter removes all games, query without it
    if (games.length === 0) {
      logger.warn(`[OddsController] No games with status filter for ${sport}, trying fallback...`);
      games = await Game.find({
        sport,
        startTime: { $gte: windowStart, $lte: windowEnd },
      })
        .sort({ startTime: 1 })
        .select('-__v')
        .lean();
      logger.info(`[OddsController] Fallback query found ${games.length} games for ${sport}`);
    }

    // Enrich games with live prop stats so frontend can show badges without extra calls
    const enrichedGames = await _enrichGamesWithPropStats(games);

    // Cache the enriched result
    await cacheSet(cacheKey, enrichedGames, CACHE_TTL.SCHEDULE);

    logger.debug(`[OddsController] Games fetched from DB for ${sport}: ${games.length}`);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      source: 'database',
      data: enrichedGames,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Props ─────────────────────────────────────────────────────────────────

/**
 * GET /api/odds/:sport/games/:eventId/props
 * Returns player props for a specific game.
 *
 * Supports filtering: ?filter=highConfidence | ?filter=bestValue
 *
 * For guest users: returns props with isLocked=true (insight text is blurred on frontend).
 * For authenticated users: shows if each prop's insight has been unlocked.
 */
const getProps = async (req, res, next) => {
  try {
    const { sport, eventId } = req.params;
    const { filter } = req.query;
    const cacheKey = `${CACHE_KEYS.PROPS}:${sport}:${eventId}:${filter || 'all'}`;

    // ── Check Redis cache ──────────────────────────────────────────────────
    const cached = await cacheGet(cacheKey);
    if (cached) {
      logger.debug(`⚡ [OddsController] Cache HIT — props for ${eventId}`);

      // Personalize with user's unlocked insights if authenticated
      const personalized = _personalizeProps(cached, req.user);
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        source: 'cache',
        data: personalized,
      });
    }

    // ── Build MongoDB query ────────────────────────────────────────────────
    const query = {
      sport,
      oddsEventId: eventId,
      isAvailable: true,
    };

    if (filter === 'highConfidence') query.isHighConfidence = true;
    if (filter === 'bestValue') query.isBestValue = true;

    const props = await PlayerProp.find(query)
      .sort({ confidenceScore: -1, edgePercentage: -1 })
      .select('-__v -apiSportsPlayerId') // Don't expose internal IDs
      .lean();

    // Cache the raw props (without personalization)
    await cacheSet(cacheKey, props, CACHE_TTL.PROPS);

    // Personalize for the authenticated user
    const personalized = _personalizeProps(props, req.user);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      source: 'database',
      data: personalized,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Add per-user context to props:
 *  - isUnlocked: true if user has already unlocked the insight for this prop
 *  - isLocked: true if user hasn't unlocked it (frontend shows blurred insight)
 *
 * @param {Array} props - Raw props from DB/cache
 * @param {Object|undefined} user - Authenticated user (or undefined for guests)
 * @returns {Array} Personalized props
 */
const _personalizeProps = (props, user) => {
  return props.map((prop) => ({
    ...prop,
    isUnlocked: user && prop.insightId
      ? user.unlockedInsights?.some((id) => id.toString() === prop.insightId.toString())
      : false,
  }));
};

/**
 * Get today's date as a cache key string (YYYY-MM-DD in UTC).
 * @returns {string}
 */
const _getTodayKey = () => {
  return new Date().toISOString().split('T')[0];
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Enrich game objects with prop statistics so frontend game cards
 * can show confidence/edge badges without making extra API calls.
 *
 * Adds to each game:
 *  - propCount:       number of available props for this game
 *  - topConfidence:   highest confidence score across all props (integer %)
 *  - topEdge:         highest edge % across all props (integer %)
 */
const _enrichGamesWithPropStats = async (games) => {
  if (!games || games.length === 0) return games;

  // Batch query — get all prop stats for all games in one DB call
  const eventIds = games.map(g => g.oddsEventId);

  const propStats = await PlayerProp.aggregate([
    {
      $match: {
        oddsEventId: { $in: eventIds },
        isAvailable: true,
      },
    },
    {
      $group: {
        _id:           '$oddsEventId',
        propCount:     { $sum: 1 },
        topConfidence: { $max: '$confidenceScore' },
        topEdge:       { $max: '$edgePercentage' },
      },
    },
  ]);

  // Build lookup map
  const statsMap = {};
  for (const stat of propStats) {
    statsMap[stat._id] = {
      propCount:     stat.propCount     || 0,
      topConfidence: stat.topConfidence ? Math.round(stat.topConfidence) : null,
      topEdge:       stat.topEdge       ? Math.round(stat.topEdge)       : null,
    };
  }

  // Merge stats into game objects
  return games.map(game => ({
    ...game,
    propCount:     statsMap[game.oddsEventId]?.propCount     || 0,
    topConfidence: statsMap[game.oddsEventId]?.topConfidence || null,
    topEdge:       statsMap[game.oddsEventId]?.topEdge       || null,
  }));
};

module.exports = { getSports, getGames, getProps };
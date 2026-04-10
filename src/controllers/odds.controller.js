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

const { Game } = require('../models/Game.model');
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
        data: cached,
      });
    }

    // ── Query MongoDB ──────────────────────────────────────────────────────
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const games = await Game.find({
      sport,
      startTime: { $gte: startOfDay, $lte: endOfDay },
    })
      .sort({ startTime: 1 })
      .select('-__v')
      .lean();

    // Cache the result
    await cacheSet(cacheKey, games, CACHE_TTL.SCHEDULE);

    logger.debug(`[OddsController] Games fetched from DB for ${sport}: ${games.length}`);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      source: 'database',
      data: games,
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

module.exports = { getSports, getGames, getProps };
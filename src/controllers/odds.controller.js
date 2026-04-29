/**
 * odds.controller.js — Games and player props endpoints
 *
 * Handles:
 *  GET /api/odds/sports                          — List supported sports
 *  GET /api/odds/:sport/games                    — Today's games for a sport
 *  GET /api/odds/:sport/games/:eventId/props     — Props for a game
 *
 * Public routes — guest users can browse games and blurred props.
 * Uses Redis HOT cache for fast responses.
 *
 * CACHE STRATEGY:
 *  Games: cached after prop enrichment (propWatcher invalidates schedule keys after scoring)
 *  Props: cached without personalization (personalization applied per-request, not cached)
 */

const { Game, GAME_STATUS }  = require('../models/Game.model');
const PlayerProp             = require('../models/PlayerProp.model');
const Insight                = require('../models/Insight.model');
const { cacheGet, cacheSet, cacheDel } = require('../config/redis');
const {
  SPORTS, SPORT_LABELS, ACTIVE_SPORTS,
  CACHE_TTL, CACHE_KEYS, HTTP_STATUS, INSIGHT_STATUS,
} = require('../config/constants');
const { AppError }           = require('../middleware/errorHandler.middleware');
const logger                 = require('../config/logger');
const { getTeamLogoUrl, getApiSportsLogoUrl } = require('../services/adapters/shared/teamMaps');

// ─── Sports list ───────────────────────────────────────────────────────────────

const getSports = (req, res) => {
  const sports = Object.values(SPORTS).map((sport) => ({
    key:      sport,
    label:    SPORT_LABELS[sport],
    isActive: ACTIVE_SPORTS.includes(sport),
    status:   ACTIVE_SPORTS.includes(sport) ? 'active' : 'coming_soon',
  }));
  res.status(HTTP_STATUS.OK).json({ success: true, sports });
};

// ─── Games ─────────────────────────────────────────────────────────────────────

const getGames = async (req, res, next) => {
  try {
    const { sport } = req.params;
    const cacheKey  = `${CACHE_KEYS.SCHEDULE}:${sport}:${_getTodayKey()}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      logger.debug(`⚡ [OddsController] Cache HIT — games for ${sport}`);
      return res.status(HTTP_STATUS.OK).json({
        success: true, source: 'cache',
        data: _hydrateTeamLogos(cached),
      });
    }

    const now         = new Date();
    const windowStart = new Date(now.getTime() - 3  * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    let games = await Game.find({
      sport,
      startTime: { $gte: windowStart, $lte: windowEnd },
      status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
    }).sort({ startTime: 1 }).select('-__v').lean();

    if (games.length === 0) {
      logger.warn(`[OddsController] No games with status filter for ${sport}, trying fallback...`);
      games = await Game.find({
        sport,
        startTime: { $gte: windowStart, $lte: windowEnd },
      }).sort({ startTime: 1 }).select('-__v').lean();
      logger.info(`[OddsController] Fallback found ${games.length} games for ${sport}`);
    }

    const enriched  = await _enrichGamesWithPropStats(games, sport);
    const hydrated  = _hydrateTeamLogos(enriched);

    await cacheSet(cacheKey, hydrated, CACHE_TTL.SCHEDULE);
    logger.debug(`[OddsController] Games fetched from DB for ${sport}: ${games.length}`);

    res.status(HTTP_STATUS.OK).json({ success: true, source: 'database', data: hydrated });
  } catch (err) {
    next(err);
  }
};

// ─── Props ─────────────────────────────────────────────────────────────────────

const getProps = async (req, res, next) => {
  try {
    const { sport, eventId } = req.params;
    const { filter }   = req.query;
    const cacheKey     = `${CACHE_KEYS.PROPS}:${sport}:${eventId}:${filter || 'all'}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      logger.debug(`⚡ [OddsController] Cache HIT — props for ${eventId}`);
      // Re-check game context for backward compat with old cache entries
      let withCtx = cached;
      const needsCtx = !Array.isArray(cached) || !cached[0]?.awayTeam;
      if (needsCtx && cached.length > 0) {
        const game = await Game.findOne({ sport, oddsEventId: eventId })
          .select('awayTeam.name homeTeam.name startTime').lean();
        withCtx = _enrichPropsWithGameContext(cached, game);
      }
      return res.status(HTTP_STATUS.OK).json({
        success: true, source: 'cache',
        data: await _personalizeProps(withCtx, req.user),
      });
    }

    const game = await Game.findOne({ sport, oddsEventId: eventId })
      .select('awayTeam.name homeTeam.name startTime').lean();

    const query = { sport, oddsEventId: eventId, isAvailable: true };
    if (filter === 'highConfidence') query.isHighConfidence = true;
    if (filter === 'bestValue')      query.isBestValue      = true;

    const props = await PlayerProp.find(query)
      .sort({ confidenceScore: -1, edgePercentage: -1 })
      .select('-__v -apiSportsPlayerId')
      .lean();

    await _markGamePropsState({ sport, eventId, hasProps: props.length > 0, startTime: game?.startTime });

    const withCtx = _enrichPropsWithGameContext(props, game);
    await cacheSet(cacheKey, withCtx, CACHE_TTL.PROPS);

    res.status(HTTP_STATUS.OK).json({
      success: true, source: 'database',
      data: await _personalizeProps(withCtx, req.user),
    });
  } catch (err) {
    next(err);
  }
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * FIX 1: topEdge now uses $abs so UNDER props (negative edge) are counted.
 * FIX 2: topConfidence uses $cond to only consider isHighConfidence props,
 *         so the badge only shows if at least one HC-tagged prop exists.
 */
const _enrichGamesWithPropStats = async (games, sport) => {
  if (!games?.length) return games;

  const eventIds = games.map(g => g.oddsEventId).filter(Boolean);
  if (!eventIds.length) return games;

  const propStats = await PlayerProp.aggregate([
    {
      $match: {
        sport,
        oddsEventId: { $in: eventIds },
        isAvailable: true,
      },
    },
    {
      $group: {
        _id:       '$oddsEventId',
        propCount: { $sum: 1 },

        // Only count confidence from HC-tagged props — prevents low-conf props
        // inflating the badge score shown on the game card
        topConfidence: {
          $max: {
            $cond: [
              '$isHighConfidence',
              '$confidenceScore',
              null,
            ],
          },
        },

        // Use absolute value — UNDER props have negative edgePercentage
        // e.g. Julio Rodriguez runs -73% edge should show as 73%, not be ignored
        topEdge: {
          $max: { $abs: '$edgePercentage' },
        },
      },
    },
  ]);

  const statsMap = new Map(propStats.map(s => [s._id, s]));

  return games.map(game => {
    const stats = statsMap.get(game.oddsEventId);
    return {
      ...game,
      propCount:     stats?.propCount     || 0,
      hasProps:      (stats?.propCount    || 0) > 0,
      topConfidence: stats?.topConfidence ? Math.round(stats.topConfidence) : null,
      topEdge:       stats?.topEdge       ? Math.round(stats.topEdge)       : null,
    };
  });
};

/**
 * FIX 3: _personalizeProps no longer uses prop.insightId (doesn't exist on PlayerProp).
 * Instead looks up whether user has unlocked an insight matching this prop's
 * playerName + statType + oddsEventId composite key.
 *
 * This is an async operation — fetches user's unlocked insight IDs once,
 * then checks each prop against the Insight collection.
 * Cached per-request (not Redis) — only called for authenticated users.
 */
const _personalizeProps = async (props, user) => {
  if (!user || !props?.length) {
    return (props || []).map(p => ({ ...p, isUnlocked: false }));
  }

  const unlockedIds = user.unlockedInsights || [];
  if (!unlockedIds.length) {
    return props.map(p => ({ ...p, isUnlocked: false }));
  }

  // Build a set of "playerName::statType::oddsEventId" for all unlocked insights
  // Single DB call for all props in this game at once
  const eventId    = props[0]?.oddsEventId;
  const sport      = props[0]?.sport;
  const playerKeys = new Set();

  if (eventId && sport) {
    const unlockedInsights = await Insight.find({
      _id:     { $in: unlockedIds },
      sport,
      eventId,
      status:  INSIGHT_STATUS.GENERATED,
    }).select('playerName statType').lean();

    for (const ins of unlockedInsights) {
      playerKeys.add(`${ins.playerName}::${ins.statType}`);
    }
  }

  return props.map(p => ({
    ...p,
    isUnlocked: playerKeys.has(`${p.playerName}::${p.statType}`),
  }));
};

const _enrichPropsWithGameContext = (props, game) => {
  if (!props?.length) return props || [];
  return props.map(prop => ({
    ...prop,
    awayTeam:      game?.awayTeam?.name  || null,
    homeTeam:      game?.homeTeam?.name  || null,
    gameStartTime: game?.startTime       || null,
  }));
};

const _getTodayKey = () => new Date().toISOString().split('T')[0];

const _markGamePropsState = async ({ sport, eventId, hasProps, startTime }) => {
  await Game.updateOne({ sport, oddsEventId: eventId }, { $set: { hasProps } });

  const keys = new Set([`${CACHE_KEYS.SCHEDULE}:${sport}:${_getTodayKey()}`]);
  if (startTime) {
    keys.add(`${CACHE_KEYS.SCHEDULE}:${sport}:${new Date(startTime).toISOString().split('T')[0]}`);
  }
  await Promise.all([...keys].map(k => cacheDel(k)));
};

const _resolveTeamLogoUrl = (sport, team) => {
  if (!team) return null;
  if (team.logoUrl) return team.logoUrl;
  if (team.logo)    return team.logo;
  return getTeamLogoUrl(sport, team.name) || getApiSportsLogoUrl(sport, team.name) || null;
};

const _hydrateTeamLogos = (games) => {
  if (!Array.isArray(games) || !games.length) return games || [];
  return games.map(game => ({
    ...game,
    homeTeam: game.homeTeam ? { ...game.homeTeam, logoUrl: _resolveTeamLogoUrl(game.sport, game.homeTeam) } : game.homeTeam,
    awayTeam: game.awayTeam ? { ...game.awayTeam, logoUrl: _resolveTeamLogoUrl(game.sport, game.awayTeam) } : game.awayTeam,
  }));
};

module.exports = { getSports, getGames, getProps };
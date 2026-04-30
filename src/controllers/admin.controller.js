/**
 * admin.controller.js — Admin-only platform management endpoints
 *
 * All routes are protected by (protect + restrictTo(ADMIN)) middleware.
 *
 * Endpoints:
 *  GET  /api/admin/stats          — Platform overview stats + accuracy + prediction log
 *  GET  /api/admin/users          — Paginated user list
 *  GET  /api/admin/users/:id      — Single user detail
 *  PATCH /api/admin/users/:id/credits  — Adjust credits
 *  PATCH /api/admin/users/:id/status   — Enable/disable account
 *  POST /api/admin/cron/:job      — Manual cron trigger
 *  GET  /api/admin/insights       — Paginated insight list
 *  DELETE /api/admin/insights/:id — Delete insight
 *  GET  /api/admin/logs/ai        — AI generation logs
 *  GET  /api/admin/players/health — Player ID health check
 *  POST /api/admin/players/:name/override — Set manual player ID override
 */

const User        = require('../models/User.model');
const Insight     = require('../models/Insight.model');
const Transaction = require('../models/Transaction.model');
const PlayerProp  = require('../models/PlayerProp.model');
const { Game }    = require('../models/Game.model');
const { PlayerCache } = require('../utils/playerResolver');
const {
  HTTP_STATUS, USER_ROLES, TRANSACTION_TYPES, INSIGHT_STATUS,
} = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// ─── Platform Stats ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 * Returns platform overview + accuracy metrics + recent prediction log
 */
const getPlatformStats = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);

    const startOf30DaysAgo = new Date(now);
    startOf30DaysAgo.setDate(startOf30DaysAgo.getDate() - 30);

    const startOf7DaysAgo = new Date(now);
    startOf7DaysAgo.setDate(startOf7DaysAgo.getDate() - 7);

    // Run all queries in parallel
    const [
      totalUsers,
      newUsersToday,
      newUsersThisWeek,
      totalInsights,
      insightsToday,
      insightsThisWeek,
      totalCreditsSpent,
      totalRevenueCents,
      activePropsCount,
      scheduledGamesCount,
      // Accuracy: insights by confidence label breakdown
      confidenceBreakdown,
      // Accuracy: insights by dataQuality
      dataQualityBreakdown,
      // Accuracy: insights by recommendation
      recommendationBreakdown,
      // Recent insights for prediction log (last 20)
      recentInsights,
      // HC/BV tag counts
      hcCount,
      bvCount,
      // Avg edge on recent insights
      avgEdgeResult,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ createdAt: { $gte: startOf7DaysAgo } }),
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED }),
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED, createdAt: { $gte: startOfToday } }),
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED, createdAt: { $gte: startOf7DaysAgo } }),

      Transaction.aggregate([
        { $match: { type: TRANSACTION_TYPES.INSIGHT_UNLOCK } },
        { $group: { _id: null, total: { $sum: { $abs: '$creditDelta' } } } },
      ]),

      Transaction.aggregate([
        { $match: { type: TRANSACTION_TYPES.PURCHASE } },
        { $group: { _id: null, total: { $sum: '$stripe.amountPaid' } } },
      ]),

      PlayerProp.countDocuments({ isAvailable: true }),

      Game.countDocuments({
        status: { $in: ['scheduled', 'live'] },
        startTime: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      }),

      // Confidence label distribution
      Insight.aggregate([
        { $match: { status: INSIGHT_STATUS.GENERATED } },
        { $group: { _id: '$aiConfidenceLabel', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Data quality distribution
      Insight.aggregate([
        { $match: { status: INSIGHT_STATUS.GENERATED } },
        { $group: { _id: '$dataQuality', count: { $sum: 1 } } },
      ]),

      // Recommendation distribution (over vs under)
      Insight.aggregate([
        { $match: { status: INSIGHT_STATUS.GENERATED } },
        { $group: { _id: '$recommendation', count: { $sum: 1 } } },
      ]),

      // Recent insights for prediction log
      Insight.find({ status: INSIGHT_STATUS.GENERATED })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('playerName statType bettingLine recommendation confidenceScore edgePercentage aiConfidenceLabel dataQuality isHighConfidence isBestValue createdAt sport focusStatAvg baselineStatAvg')
        .lean(),

      // High confidence count
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED, isHighConfidence: true }),

      // Best value count
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED, isBestValue: true }),

      // Average edge on last 30 days
      Insight.aggregate([
        { $match: { status: INSIGHT_STATUS.GENERATED, createdAt: { $gte: startOf30DaysAgo } } },
        { $group: { _id: null, avgEdge: { $avg: { $abs: '$edgePercentage' } }, count: { $sum: 1 } } },
      ]),
    ]);

    // Process breakdowns into clean objects
    const confidenceMap = {};
    confidenceBreakdown.forEach(({ _id, count }) => { if (_id) confidenceMap[_id] = count; });

    const dataQualityMap = {};
    dataQualityBreakdown.forEach(({ _id, count }) => { if (_id) dataQualityMap[_id] = count; });

    const recMap = {};
    recommendationBreakdown.forEach(({ _id, count }) => { if (_id) recMap[_id] = count; });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        users: {
          total: totalUsers,
          newToday: newUsersToday,
          newThisWeek: newUsersThisWeek,
        },
        insights: {
          total: totalInsights,
          generatedToday: insightsToday,
          generatedThisWeek: insightsThisWeek,
          highConfidence: hcCount,
          bestValue: bvCount,
          // Distribution breakdowns
          byConfidence: {
            high:   confidenceMap.high   || 0,
            medium: confidenceMap.medium || 0,
            low:    confidenceMap.low    || 0,
          },
          byDataQuality: {
            strong:   dataQualityMap.strong   || 0,
            moderate: dataQualityMap.moderate || 0,
            weak:     dataQualityMap.weak     || 0,
          },
          byRecommendation: {
            over:  recMap.over  || 0,
            under: recMap.under || 0,
          },
          avgEdge30d: parseFloat((avgEdgeResult[0]?.avgEdge || 0).toFixed(1)),
        },
        economy: {
          totalCreditsSpent: totalCreditsSpent[0]?.total || 0,
          totalRevenueUSD: ((totalRevenueCents[0]?.total || 0) / 100).toFixed(2),
        },
        live: {
          availableProps: activePropsCount,
          scheduledGames: scheduledGamesCount,
        },
        // Recent prediction log
        recentInsights,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Player ID Health ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/players/health
 * Returns all cached player ID mappings with stats health status
 */
const getPlayerHealth = async (req, res, next) => {
  try {
    const { sport = 'nba', limit = 100 } = req.query;

    const cached = await PlayerCache.find({ sport })
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Get prop count per player to show which are active
    const playerNames = cached.map(p => p.oddsApiName);
    const propCounts = await PlayerProp.aggregate([
      { $match: { playerName: { $in: playerNames.map(n => new RegExp(n, 'i')) }, isAvailable: true } },
      { $group: { _id: { $toLower: '$playerName' }, count: { $sum: 1 } } },
    ]);
    const propMap = {};
    propCounts.forEach(({ _id, count }) => { propMap[_id] = count; });

    const players = cached.map(p => ({
      oddsApiName:    p.oddsApiName,
      // resolvedName = human-readable name returned by NBA Stats API
      resolvedName:   p.apiSportsName?.startsWith('override:')
                        ? null
                        : p.apiSportsName || null,
      // nbaStatsId = numeric ID used to query GET /players/statistics
      nbaStatsId:     p.apiSportsId,
      // kept as apiSportsId for DB compat — renamed in UI only
      apiSportsId:    p.apiSportsId,
      teamName:       p.teamName,
      isOverride:     p.apiSportsName?.startsWith('override:') || false,
      activePropCount: propMap[p.oddsApiName] || 0,
      updatedAt:      p.updatedAt,
    }));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      total: players.length,
      players,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/admin/players/:name/cache
 * Clear a player's cached ID so it gets re-resolved next PropWatcher run
 */
const clearPlayerCache = async (req, res, next) => {
  try {
    const { sport = 'nba' } = req.query;
    const normalized = decodeURIComponent(req.params.name)
      .toLowerCase().replace(/['.]/g, '').replace(/\s+/g, ' ').trim();

    const result = await PlayerCache.deleteOne({ oddsApiName: normalized, sport });

    logger.info('[Admin] Cleared player cache', { name: normalized, sport, deleted: result.deletedCount });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: result.deletedCount > 0
        ? `Cache cleared for "${normalized}" — will re-resolve on next PropWatcher run`
        : `No cache entry found for "${normalized}"`,
      deleted: result.deletedCount,
    });
  } catch (err) {
    next(err);
  }
};

// ─── User Management ──────────────────────────────────────────────────────────

const listUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
      ];
    }
    if (role) query.role = role;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(query),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: users,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
};

const getUserDetail = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -__v')
      .lean();

    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.status(HTTP_STATUS.OK).json({ success: true, user, transactions });
  } catch (err) {
    next(err);
  }
};

const adjustUserCredits = async (req, res, next) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || isNaN(amount)) {
      throw new AppError('Invalid amount', HTTP_STATUS.BAD_REQUEST);
    }

    const user = await User.findById(req.params.id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    const newBalance = user.credits + parseInt(amount);
    await User.findByIdAndUpdate(user._id, { $inc: { credits: parseInt(amount) } });

    await Transaction.create({
      userId: user._id,
      type: TRANSACTION_TYPES.ADMIN_GRANT,
      creditDelta: parseInt(amount),
      balanceAfter: newBalance,
      description: reason || `Admin credit adjustment: ${amount > 0 ? '+' : ''}${amount}`,
    });

    logger.info('[Admin] Credits adjusted', { userId: user._id, amount, adminId: req.user._id });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Credits adjusted by ${amount}. New balance: ${newBalance}`,
      newBalance,
    });
  } catch (err) {
    next(err);
  }
};

const setUserStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true, select: '-password' }
    );
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    logger.info('[Admin] User status changed', { userId: user._id, isActive, adminId: req.user._id });
    res.status(HTTP_STATUS.OK).json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

// ─── Cron Job Triggers ────────────────────────────────────────────────────────

const triggerCronJob = async (req, res, next) => {
  try {
    const { job } = req.params;
    const validJobs = ['morning-scraper', 'prop-watcher', 'post-game-sync', 'ai-log-cleanup'];

    if (!validJobs.includes(job)) {
      throw new AppError(`Invalid job: ${job}`, HTTP_STATUS.BAD_REQUEST);
    }

    logger.info(`👑 [AdminController] Manual cron trigger: ${job}`, { adminId: req.user._id });

    let result;
    switch (job) {
      case 'morning-scraper': {
        const MorningScraper = require('../cron/MorningScraper');
        result = await MorningScraper.run();
        break;
      }
      case 'prop-watcher': {
        const PropWatcher = require('../cron/PropWatcher');
        result = await PropWatcher.run();
        break;
      }
      case 'post-game-sync': {
        result = { message: 'Post-game sync not yet implemented' };
        break;
      }
      case 'ai-log-cleanup': {
        const deleted = await Insight.updateMany(
          { aiLogExpiresAt: { $lt: new Date() } },
          { $unset: { aiLog: 1 } }
        );
        result = { cleaned: deleted.modifiedCount };
        break;
      }
    }

    res.status(HTTP_STATUS.OK).json({ success: true, job, result });
  } catch (err) {
    next(err);
  }
};

// ─── Insights ─────────────────────────────────────────────────────────────────

const listInsights = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, sport, filter } = req.query;
    const query = { status: INSIGHT_STATUS.GENERATED };
    if (sport) query.sport = sport;
    if (filter === 'highConfidence') query.isHighConfidence = true;
    if (filter === 'bestValue') query.isBestValue = true;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [insights, total] = await Promise.all([
      Insight.find(query)
        .select('-aiLog')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Insight.countDocuments(query),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: insights,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
};

const deleteInsight = async (req, res, next) => {
  try {
    const insight = await Insight.findByIdAndDelete(req.params.id);
    if (!insight) throw new AppError('Insight not found', HTTP_STATUS.NOT_FOUND);

    logger.info('[Admin] Insight deleted', { insightId: req.params.id, adminId: req.user._id });
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Insight deleted' });
  } catch (err) {
    next(err);
  }
};

// ─── AI Logs ──────────────────────────────────────────────────────────────────

const getAILogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [insights, total] = await Promise.all([
      Insight.find({ 'aiLog.prompt': { $exists: true } })
        .select('playerName statType bettingLine recommendation aiLog createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Insight.countDocuments({ 'aiLog.prompt': { $exists: true } }),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: insights,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPlatformStats,
  getPlayerHealth,
  clearPlayerCache,
  listUsers,
  getUserDetail,
  adjustUserCredits,
  setUserStatus,
  triggerCronJob,
  listInsights,
  deleteInsight,
  getAILogs,
};


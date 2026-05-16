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
const InsightOutcomeService = require('../services/InsightOutcomeService');

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
      outcomesSummary,
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

      // Outcome summary for admin dashboard / outcomes page
      InsightOutcomeService.getOutcomeSummary({ sinceDays: 30, limit: 300, includeSamples: true }),
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
        outcomes: outcomesSummary,
        // Recent prediction log
        recentInsights,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Player ID Health ──────────────────────────────────────────────────────────

// Player ID cache health/clear endpoints removed.
// PlayerCache model is still used by InsightOutcomeService for grading;
// no admin UI is needed since the cache is self-healing on each grading run.

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
    logger.info(`👑 [AdminController] Manual cron trigger: ${job}`, { adminId: req.user._id });

    let result;

    // Job key → actual file path (all paths relative to controllers/)
    // Structure: jobs/orchestrators/ for full-sport runners
    //            jobs/sports/{sport}/ for per-sport isolation
    const JOB_MAP = {
      'morning-scraper':    ['../jobs/morningScraper.job',                'runMorningScraper'],
      'prop-watcher':       ['../jobs/orchestrators/propWatcher.job',     'runPropWatcher'],
      'prop-watcher-nba':   ['../jobs/sports/nba/propWatcher',            'run'],
      'prop-watcher-mlb':   ['../jobs/sports/mlb/propWatcher',            'run'],
      'prop-watcher-nfl':   ['../jobs/sports/nfl/propWatcher',            'run'],
      'prop-watcher-nhl':   ['../jobs/sports/nhl/propWatcher',            'run'],
      'prop-watcher-soccer':['../jobs/sports/soccer/propWatcher',         'run'],
      'post-game-sync':     ['../jobs/orchestrators/postGameSync.job',    'runPostGameSync'],
      'post-game-sync-nba': ['../jobs/sports/nba/postGameSync',           'run'],
      'post-game-sync-mlb': ['../jobs/sports/mlb/postGameSync',           'run'],
      'post-game-sync-nfl': ['../jobs/sports/nfl/postGameSync',           'run'],
      'post-game-sync-nhl': ['../jobs/sports/nhl/postGameSync',           'run'],
      'post-game-sync-soccer': ['../jobs/sports/soccer/postGameSync',     'run'],
      'ai-log-cleanup':     ['../jobs/orchestrators/postGameSync.job',    'runAILogCleanup'],
    };

    const jobEntry = JOB_MAP[job];
    if (!jobEntry) {
      throw new AppError(
        `Unknown job: "${job}". Valid: ${Object.keys(JOB_MAP).join(', ')}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const [modulePath, fnName] = jobEntry;
    const jobModule = require(modulePath);
    const fn = jobModule[fnName];

    if (typeof fn !== 'function') {
      throw new AppError(`Job module loaded but "${fnName}" is not a function`, 500);
    }

    result = await fn();

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
// getAILogs endpoint removed. AI log retention is handled automatically by
// the daily 3AM cron via Insight.aiLogExpiresAt TTL. Admins no longer have
// a UI surface for raw prompt/response inspection.

// ─── Performance / Outcome Audit (per-game) ──────────────────────────────────

const PerformanceService = require('../services/PerformanceService');

/**
 * GET /api/admin/performance/games?sport=all&days=30&page=1&limit=20
 * Per-game accuracy report — graded insights aggregated by event with
 * win/loss/push counts and basic game metadata.
 */
const getPerGameReport = async (req, res, next) => {
  try {
    const data = await PerformanceService.getPerGameReport({
      sport: req.query.sport || 'all',
      days:  parseInt(req.query.days  || '30', 10),
      page:  parseInt(req.query.page  || '1',  10),
      limit: parseInt(req.query.limit || '20', 10),
    });
    res.status(HTTP_STATUS.OK).json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/performance/games/:eventId
 * Full insight roster for one game with per-insight outcome detail.
 */
const getGameDetail = async (req, res, next) => {
  try {
    const data = await PerformanceService.getGameDetail(req.params.eventId);
    if (!data) {
      throw new AppError('Game not found', HTTP_STATUS.NOT_FOUND);
    }
    res.status(HTTP_STATUS.OK).json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/performance/prune-exhausted
 * Manual trigger for the lifecycle prune (deletes exhausted-retry insights
 * older than RETRY_EXHAUSTED_PRUNE_DAYS). Daily cron also calls this.
 */
const pruneExhaustedRetries = async (req, res, next) => {
  try {
    const result = await PerformanceService.pruneExhaustedRetries({
      days: parseInt(req.body?.days || '14', 10),
    });
    res.status(HTTP_STATUS.OK).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/performance/archive
 * Lifetime totals per sport (PerformanceArchive collection).
 */
const getArchiveSnapshot = async (req, res, next) => {
  try {
    const snapshot = await PerformanceService.getArchiveSnapshot();
    res.status(HTTP_STATUS.OK).json({ success: true, archive: snapshot });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/performance/archive-graded
 * Manual trigger for rolling-window archive: aggregates graded insights
 * older than `days` (default 90) into PerformanceArchive, then deletes them.
 * Same operation the daily 3AM cron runs.
 */
const archiveAndPruneGraded = async (req, res, next) => {
  try {
    const result = await PerformanceService.archiveAndPruneGraded({
      days:   parseInt(req.body?.days || '90', 10),
      dryRun: !!req.body?.dryRun,
    });
    res.status(HTTP_STATUS.OK).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPlatformStats,
  listUsers,
  getUserDetail,
  adjustUserCredits,
  setUserStatus,
  triggerCronJob,
  listInsights,
  deleteInsight,
  // Performance / per-game outcome audit
  getPerGameReport,
  getGameDetail,
  pruneExhaustedRetries,
  getArchiveSnapshot,
  archiveAndPruneGraded,
};
/**
 * admin.controller.js — Admin-only endpoints
 *
 * All routes here require: protect + restrictTo('admin')
 *
 * Handles:
 *  GET  /api/admin/stats              — Platform overview (users, insights, revenue)
 *  GET  /api/admin/users              — List all users (paginated + searchable)
 *  GET  /api/admin/users/:id          — Get single user detail
 *  PATCH /api/admin/users/:id/credits — Manually grant/deduct credits
 *  PATCH /api/admin/users/:id/status  — Activate / deactivate account
 *  POST /api/admin/cron/:job          — Manually trigger a cron job
 *  GET  /api/admin/insights           — List all insights with AI logs
 *  DELETE /api/admin/insights/:id     — Delete a specific insight (e.g. bad AI output)
 *  GET  /api/admin/logs/ai            — Recent AI input/output log entries
 */

const User = require('../models/User.model');
const Insight = require('../models/Insight.model');
const Transaction = require('../models/Transaction.model');
const PlayerProp = require('../models/PlayerProp.model');
const { Game } = require('../models/Game.model');
const { HTTP_STATUS, USER_ROLES, TRANSACTION_TYPES, INSIGHT_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// ─── Platform Stats ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 * Returns high-level platform metrics for the admin dashboard.
 */
const getPlatformStats = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);

    const startOf30DaysAgo = new Date(now);
    startOf30DaysAgo.setDate(startOf30DaysAgo.getDate() - 30);

    // Run all queries in parallel for performance
    const [
      totalUsers,
      newUsersToday,
      totalInsights,
      insightsToday,
      totalCreditsSpent,
      totalRevenueCents,
      activePropsCount,
      scheduledGamesCount,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED }),
      Insight.countDocuments({ status: INSIGHT_STATUS.GENERATED, createdAt: { $gte: startOfToday } }),

      // Total credits spent on insights (absolute value of negative deltas)
      Transaction.aggregate([
        { $match: { type: TRANSACTION_TYPES.INSIGHT_UNLOCK } },
        { $group: { _id: null, total: { $sum: { $abs: '$creditDelta' } } } },
      ]),

      // Total revenue from Stripe purchases (in cents)
      Transaction.aggregate([
        { $match: { type: TRANSACTION_TYPES.PURCHASE } },
        { $group: { _id: null, total: { $sum: '$stripe.amountPaid' } } },
      ]),

      PlayerProp.countDocuments({ isAvailable: true }),
      // Count only upcoming games (within 72h window, same as odds controller)
      Game.countDocuments({
        status: { $in: ['scheduled', 'live'] },
        startTime: { $gte: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      }),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        users: {
          total: totalUsers,
          newToday: newUsersToday,
        },
        insights: {
          total: totalInsights,
          generatedToday: insightsToday,
        },
        economy: {
          totalCreditsSpent: totalCreditsSpent[0]?.total || 0,
          // Convert cents to dollars for display
          totalRevenueUSD: ((totalRevenueCents[0]?.total || 0) / 100).toFixed(2),
        },
        live: {
          availableProps: activePropsCount,
          scheduledGames: scheduledGamesCount,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── User Management ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/users?page=1&limit=20&search=john&role=user
 */
const listUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};

    if (search) {
      // Search by name or email (case-insensitive)
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    if (role && Object.values(USER_ROLES).includes(role)) {
      query.role = role;
    }

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -passwordResetToken -passwordResetExpires -unlockedInsights')
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
        limit: parseInt(limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/users/:id
 */
const getUserDetail = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -passwordResetToken -passwordResetExpires')
      .lean();

    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    // Get user's recent transactions
    const recentTransactions = await Transaction.find({ userId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      user,
      recentTransactions,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/admin/users/:id/credits
 * Manually adjust a user's credit balance (grant or deduct).
 *
 * Body: { delta: number, reason: string }
 * delta can be positive (grant) or negative (deduct)
 */
const adjustUserCredits = async (req, res, next) => {
  try {
    const { delta, reason } = req.body;

    if (typeof delta !== 'number' || delta === 0) {
      throw new AppError('delta must be a non-zero number', HTTP_STATUS.BAD_REQUEST);
    }
    if (!reason || reason.trim().length === 0) {
      throw new AppError('reason is required', HTTP_STATUS.BAD_REQUEST);
    }

    const user = await User.findById(req.params.id);
    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    const newBalance = user.credits + delta;
    if (newBalance < 0) {
      throw new AppError(
        `Cannot deduct ${Math.abs(delta)} credits — user only has ${user.credits}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    await User.findByIdAndUpdate(req.params.id, { $inc: { credits: delta } });

    await Transaction.create({
      userId: req.params.id,
      type: TRANSACTION_TYPES.ADMIN_GRANT,
      creditDelta: delta,
      balanceAfter: newBalance,
      description: `Admin adjustment: ${reason}`,
    });

    logger.info('👑 [AdminController] Credits adjusted', {
      adminId: req.user._id,
      targetUserId: req.params.id,
      delta,
      newBalance,
      reason,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Credits adjusted by ${delta}. New balance: ${newBalance}`,
      newBalance,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/admin/users/:id/status
 * Activate or deactivate a user account.
 *
 * Body: { isActive: boolean }
 */
const setUserStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      throw new AppError('isActive must be a boolean', HTTP_STATUS.BAD_REQUEST);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    ).select('name email isActive');

    if (!user) throw new AppError('User not found', HTTP_STATUS.NOT_FOUND);

    logger.info('👑 [AdminController] User status changed', {
      adminId: req.user._id,
      targetUserId: req.params.id,
      isActive,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Manual Cron Triggers ──────────────────────────────────────────────────────

/**
 * POST /api/admin/cron/:job
 * Manually trigger a cron job for testing without waiting for schedule.
 *
 * :job can be: morning-scraper | prop-watcher | post-game-sync | ai-log-cleanup
 */
const triggerCronJob = async (req, res, next) => {
  try {
    const { job } = req.params;

    logger.info(`👑 [AdminController] Manual cron trigger: ${job}`, {
      adminId: req.user._id,
    });

    let result;

    switch (job) {
      case 'morning-scraper': {
        const { runMorningScraper } = require('../jobs/morningScraper.job');
        result = await runMorningScraper();
        break;
      }
      case 'prop-watcher': {
        const { runPropWatcher } = require('../jobs/propWatcher.job');
        result = await runPropWatcher();
        break;
      }
      case 'post-game-sync': {
        const { runPostGameSync } = require('../jobs/postGameSync.job');
        result = await runPostGameSync();
        break;
      }
      case 'ai-log-cleanup': {
        const { runAILogCleanup } = require('../jobs/postGameSync.job');
        result = await runAILogCleanup();
        break;
      }
      default:
        throw new AppError(
          `Unknown job: "${job}". Valid options: morning-scraper, prop-watcher, post-game-sync, ai-log-cleanup`,
          HTTP_STATUS.BAD_REQUEST
        );
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Cron job "${job}" triggered successfully`,
      result,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Insight Management ────────────────────────────────────────────────────────

/**
 * GET /api/admin/insights?sport=nba&status=generated&page=1
 * Returns insights WITH AI logs (admin-only — never exposed to regular users).
 */
const listInsights = async (req, res, next) => {
  try {
    const { sport, status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};
    if (sport) query.sport = sport;
    if (status) query.status = status;

    const [insights, total] = await Promise.all([
      Insight.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(), // Include aiLog (admin only)
      Insight.countDocuments(query),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: insights,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/admin/insights/:id
 * Delete a bad/incorrect insight so it gets regenerated next time.
 */
const deleteInsight = async (req, res, next) => {
  try {
    const insight = await Insight.findByIdAndDelete(req.params.id);
    if (!insight) throw new AppError('Insight not found', HTTP_STATUS.NOT_FOUND);

    logger.info('👑 [AdminController] Insight deleted', {
      adminId: req.user._id,
      insightId: req.params.id,
      playerName: insight.playerName,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Insight deleted. It will be regenerated on next unlock request.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/logs/ai?page=1&limit=10
 * Returns recent AI input/output logs for debugging prompt quality.
 * Only returns insights where aiLog field still exists (not yet cleaned up).
 */
const getAILogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const logs = await Insight.find({ aiLog: { $exists: true, $ne: null } })
      .select('sport playerName statType bettingLine recommendation status createdAt aiLog')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await Insight.countDocuments({ aiLog: { $exists: true, $ne: null } });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: logs,
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

module.exports = {
  getPlatformStats,
  listUsers,
  getUserDetail,
  adjustUserCredits,
  setUserStatus,
  triggerCronJob,
  listInsights,
  deleteInsight,
  getAILogs,
};
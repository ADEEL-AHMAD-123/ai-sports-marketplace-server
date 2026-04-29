/**
 * insight.controller.js — AI insight endpoints
 *
 * Handles:
 *  POST /api/insights/unlock     — Unlock (generate or retrieve) an insight
 *  GET  /api/insights/:id        — Get a specific insight by ID
 *  GET  /api/insights            — List insights with filters (High Confidence, Best Value)
 */

const InsightService = require('../services/InsightService');
const Insight = require('../models/Insight.model');
const PlayerProp = require('../models/PlayerProp.model');
const { HTTP_STATUS, CREDITS, INSIGHT_STATUS } = require('../config/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const logger = require('../config/logger');

// ─── Unlock Insight ────────────────────────────────────────────────────────────

/**
 * POST /api/insights/unlock
 *
 * The core action of the app:
 *  1. Check if user already unlocked this insight → return free
 *  2. Check user has enough credits
 *  3. Delegate to InsightService (cache check → preflight → AI → deduct credit)
 *
 * Request body:
 *  { sport, eventId, playerName, statType, bettingLine, marketType }
 */
const unlockInsight = async (req, res, next) => {
  try {
    const { sport, eventId, playerName, statType, bettingLine, marketType } = req.body;
    const user = req.user;

    logger.info('🔓 [InsightController] Unlock request', {
      userId: user._id,
      sport,
      playerName,
      statType,
      bettingLine,
    });

    // ── Check if user already has this insight unlocked ──────────────────────
    // If so, fetch and return for free (no credit check needed)
    const existingInsight = await Insight.findExisting({
      sport,
      eventId,
      playerName,
      statType,
      bettingLine,
    });

    if (existingInsight && user.hasUnlockedInsight(existingInsight._id)) {
      logger.info('♻️  [InsightController] Returning previously unlocked insight for free', {
        userId: user._id,
        insightId: existingInsight._id,
      });

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Insight retrieved (already unlocked)',
        creditDeducted: false,
        insight: existingInsight,
      });
    }

    // ── Check credit balance ────────────────────────────────────────────────
    if (!user.hasEnoughCredits(CREDITS.COST_PER_INSIGHT)) {
      logger.warn('💸 [InsightController] Insufficient credits', {
        userId: user._id,
        credits: user.credits,
        required: CREDITS.COST_PER_INSIGHT,
      });

      throw new AppError(
        `Insufficient credits. You need ${CREDITS.COST_PER_INSIGHT} credit to unlock this insight. Purchase more credits to continue.`,
        402 // Payment Required
      );
    }

    // ── Generate or retrieve insight ────────────────────────────────────────
    const result = await InsightService.generateInsight({
      sport,
      eventId,
      playerName,
      statType,
      bettingLine: parseFloat(bettingLine),
      marketType,
      user,
    });

    // Pre-flight check failed (odds changed or market closed)
    if (result.preflightFailed) {
      const requestedLine = parseFloat(bettingLine);
      const currentLine = typeof result.currentLine === 'number' ? result.currentLine : null;
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        message: result.reason || 'Odds have changed. Please refresh and try again.',
        preflightFailed: true,
        creditDeducted: false,
        currentLine,
        requestedLine: Number.isFinite(requestedLine) ? requestedLine : null,
        lineDelta: currentLine != null && Number.isFinite(requestedLine)
          ? parseFloat((currentLine - requestedLine).toFixed(2))
          : null,
      });
    }

    // AI or data fetch failed
    if (!result.insight) {
      if (result.injuryInfo?.skip) {
        return res.status(HTTP_STATUS.UNPROCESSABLE).json({
          success: false,
          message: result.error || 'Insight not generated due to player injury status.',
          creditDeducted: false,
          injuryInfo: result.injuryInfo,
        });
      }

      throw new AppError(
        result.error || 'Failed to generate insight. Please try again.',
        HTTP_STATUS.INTERNAL_ERROR
      );
    }

    logger.info('✅ [InsightController] Insight unlocked', {
      userId: user._id,
      insightId: result.insight._id,
      creditDeducted: result.creditDeducted,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: result.creditDeducted ? 'Insight unlocked!' : 'Insight retrieved from cache',
      creditDeducted: result.creditDeducted,
      remainingCredits: result.creditDeducted ? user.credits - CREDITS.COST_PER_INSIGHT : user.credits,
      insight: result.insight,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get single insight ────────────────────────────────────────────────────────

/**
 * GET /api/insights/:id
 * Returns a specific insight. User must have previously unlocked it.
 */
const getInsight = async (req, res, next) => {
  try {
    const insight = await Insight.findById(req.params.id).lean();

    if (!insight) {
      throw new AppError('Insight not found', HTTP_STATUS.NOT_FOUND);
    }

    // Verify the user has unlocked this insight
    if (!req.user.hasUnlockedInsight(insight._id)) {
      throw new AppError('You have not unlocked this insight.', HTTP_STATUS.FORBIDDEN);
    }

    // Strip internal AI log data from the response
    const { aiLog, ...publicInsight } = insight;

    res.status(HTTP_STATUS.OK).json({ success: true, insight: publicInsight });
  } catch (err) {
    next(err);
  }
};

// ─── List insights (with filters) ─────────────────────────────────────────────

/**
 * GET /api/insights?sport=nba&filter=highConfidence&page=1&limit=20
 *
 * Used by the frontend filter bar.
 * Supports: All, High Confidence, Best Value filters.
 * Returns public insight data (not full AI logs).
 */
const listInsights = async (req, res, next) => {
  try {
    const {
      sport,
      filter,        // 'highConfidence' | 'bestValue' | undefined (all)
      page = 1,
      limit = 20,
    } = req.query;

    // Build the query
    const query = { status: INSIGHT_STATUS.GENERATED };

    if (sport) query.sport = sport;

    if (filter === 'highConfidence') query.isHighConfidence = true;
    if (filter === 'bestValue') query.isBestValue = true;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [insights, total] = await Promise.all([
      Insight.find(query)
        .select('-aiLog') // Never return AI logs to the frontend
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
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

// ─── List current user's unlocked insight history ───────────────────────────

/**
 * GET /api/insights/my-history?filter=highConfidence&page=1&limit=20
 *
 * Returns only insights unlocked by the current user.
 */
const listMyHistory = async (req, res, next) => {
  try {
    const {
      filter,
      page = 1,
      limit = 20,
    } = req.query;

    const unlockedIds = req.user.unlockedInsights || [];

    const query = {
      _id: { $in: unlockedIds },
      status: INSIGHT_STATUS.GENERATED,
    };

    if (filter === 'highConfidence') query.isHighConfidence = true;
    if (filter === 'bestValue') query.isBestValue = true;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const [insights, total] = await Promise.all([
      Insight.find(query)
        .select('-aiLog')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Insight.countDocuments(query),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: insights,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { unlockInsight, getInsight, listInsights, listMyHistory };
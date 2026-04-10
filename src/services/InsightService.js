/**
 * InsightService.js — Core AI insight generation engine
 *
 * This is the most critical service in the application.
 * It orchestrates the full data → formula → AI → store pipeline.
 *
 * Flow (from architecture plan):
 *  1. Check MongoDB cold cache — return instantly if insight exists
 *  2. Pre-flight check — verify odds haven't changed significantly
 *  3. Fetch player stats (MongoDB warm cache OR API-Sports)
 *  4. Apply sport-specific formulas via adapter
 *  5. Inject betting context (line) into prompt
 *  6. Call OpenAI
 *  7. Store result in MongoDB cold cache
 *  8. Deduct 1 credit from user
 *
 * Credit rules (STRICTLY enforced here):
 *  - DO NOT deduct if insight already in cache
 *  - DO NOT deduct if pre-flight check fails (odds changed/market closed)
 *  - DO NOT deduct if OpenAI fails (auto-refund)
 */

const OpenAI = require('openai');
const Insight = require('../models/Insight.model');
const Transaction = require('../models/Transaction.model');
const User = require('../models/User.model');
const PlayerProp = require('../models/PlayerProp.model');
const { getAdapter } = require('./adapters/adapterRegistry');
const {
  INSIGHT_STATUS,
  ODDS_CHANGE_THRESHOLD,
  AI_PROMPT,
  CREDITS,
  TRANSACTION_TYPES,
  SPORTS,
} = require('../config/constants');
const logger = require('../config/logger');

// ─── OpenAI client ─────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class InsightService {
  /**
   * Main entry point: generate or retrieve a betting insight.
   *
   * @param {Object} params
   * @param {string} params.sport         - e.g., 'nba'
   * @param {string} params.eventId       - The Odds API event ID
   * @param {string} params.playerName
   * @param {string} params.statType      - e.g., 'points', 'rebounds'
   * @param {number} params.bettingLine   - The line (e.g., 25.5)
   * @param {string} params.marketType    - e.g., 'player_prop'
   * @param {Object} params.user          - Mongoose User document (with credits)
   * @param {number|null} params.apiSportsPlayerId - API-Sports player ID (optional — fetched from prop if not provided)
   * @returns {Promise<{ insight: Object, creditDeducted: boolean }>}
   */
  async generateInsight({
    sport,
    eventId,
    playerName,
    statType,
    bettingLine,
    marketType,
    user,
    apiSportsPlayerId = null,
  }) {
    const logContext = { sport, eventId, playerName, statType, bettingLine, userId: user._id };
    logger.info('🧠 [InsightService] Starting insight generation', logContext);

    // ── STEP 1: Check cold cache (MongoDB) ────────────────────────────────────
    // If this exact insight already exists and is valid → return instantly
    const existing = await Insight.findExisting({ sport, eventId, playerName, statType, bettingLine });

    if (existing) {
      logger.info('⚡ [InsightService] Cache HIT — returning stored insight', logContext);

      // Track that this user unlocked it (without deducting credits again)
      if (!user.hasUnlockedInsight(existing._id)) {
        await User.findByIdAndUpdate(user._id, {
          $addToSet: { unlockedInsights: existing._id },
        });
        await Insight.findByIdAndUpdate(existing._id, { $inc: { unlockCount: 1 } });
      }

      return { insight: existing, creditDeducted: false };
    }

    logger.info('💨 [InsightService] Cache MISS — generating new insight', logContext);

    // ── STEP 2: Pre-flight check — verify current odds ────────────────────────
    // ALWAYS fetch fresh odds before generating an insight.
    // If the line has moved significantly, abort and tell the user to refresh.
    const preflightResult = await this._runPreflightCheck({
      sport,
      eventId,
      playerName,
      statType,
      bettingLine,
    });

    if (!preflightResult.passed) {
      logger.warn('🔴 [InsightService] Pre-flight FAILED — odds changed or market closed', {
        ...logContext,
        reason: preflightResult.reason,
        currentLine: preflightResult.currentLine,
      });
      return { insight: null, creditDeducted: false, preflightFailed: true, reason: preflightResult.reason };
    }

    logger.info('✅ [InsightService] Pre-flight passed', logContext);

    // ── STEP 3: Fetch player stats ─────────────────────────────────────────────
    // Try to find the player ID from the stored prop if not provided
    let resolvedPlayerId = apiSportsPlayerId;
    if (!resolvedPlayerId) {
      const prop = await PlayerProp.findOne({ oddsEventId: eventId, playerName, statType }).lean();
      resolvedPlayerId = prop?.apiSportsPlayerId || null;
    }

    let rawStats = [];
    if (resolvedPlayerId) {
      try {
        const adapter = getAdapter(sport);
        rawStats = await adapter.fetchPlayerStats({ playerId: resolvedPlayerId });
      } catch (statsError) {
        logger.warn('[InsightService] Could not fetch player stats — proceeding with empty stats', {
          ...logContext,
          error: statsError.message,
        });
        // Proceed with empty stats — AI can still give basic insight from the prompt context
      }
    }

    // ── STEP 4: Apply formulas ─────────────────────────────────────────────────
    const adapter = getAdapter(sport);
    const processedStats = adapter.applyFormulas(rawStats, statType);

    logger.debug('📐 [InsightService] Formulas applied', { ...logContext, processedStats });

    // ── STEP 5: Build AI prompt with betting context ───────────────────────────
    const prompt = adapter.buildPrompt({
      processedStats,
      playerName,
      statType,
      bettingLine,
      marketType,
    });

    logger.debug('📝 [InsightService] Prompt built', { ...logContext, promptLength: prompt.length });

    // ── STEP 6: Call OpenAI ────────────────────────────────────────────────────
    let aiResponse;
    let aiLog;

    try {
      aiResponse = await this._callOpenAI(prompt, logContext);
      aiLog = aiResponse.log;
    } catch (aiError) {
      logger.error('❌ [InsightService] OpenAI call failed — refunding credits not needed (not yet deducted)', {
        ...logContext,
        error: aiError.message,
      });
      // Credits were never deducted — we haven't charged yet at this point
      return { insight: null, creditDeducted: false, error: 'AI generation failed. Please try again.' };
    }

    // ── STEP 7: Parse AI response ──────────────────────────────────────────────
    const parsed = this._parseAIResponse(aiResponse.text);

    // ── STEP 8: Calculate strategy scores ─────────────────────────────────────
    const { confidenceScore, edgePercentage, isHighConfidence, isBestValue } =
      this._calculateStrategyScores(processedStats, parsed, bettingLine);

    // ── STEP 9: Save to MongoDB (cold cache) ──────────────────────────────────
    const aiLogRetentionDays = parseInt(process.env.AI_LOG_RETENTION_DAYS || '30', 10);
    const aiLogExpiresAt = new Date();
    aiLogExpiresAt.setDate(aiLogExpiresAt.getDate() + aiLogRetentionDays);

    const insight = await Insight.create({
      sport,
      eventId,
      playerName,
      statType,
      marketType,
      bettingLine,
      recommendation: parsed.recommendation,
      insightText: aiResponse.text,
      confidenceScore,
      edgePercentage,
      isHighConfidence,
      isBestValue,
      status: INSIGHT_STATUS.GENERATED,
      oddsSnapshot: {
        line: preflightResult.currentLine,
        fetchedAt: new Date(),
      },
      aiLog: {
        prompt,
        rawResponse: aiResponse.text,
        tokensUsed: aiLog.tokensUsed,
        model: aiLog.model,
        latencyMs: aiLog.latencyMs,
        processedStats,
      },
      aiLogExpiresAt,
      unlockCount: 1,
    });

    logger.info('✅ [InsightService] Insight stored in cold cache', { ...logContext, insightId: insight._id });

    // ── STEP 10: Deduct 1 credit ───────────────────────────────────────────────
    // We only reach this point if everything succeeded
    await this._deductCredit({ user, insight, logContext });

    return { insight: insight.toObject(), creditDeducted: true };
  }

  // ─── Pre-flight Check ──────────────────────────────────────────────────────

  /**
   * Verify that odds haven't changed significantly before generating an insight.
   * This prevents generating insights for stale/closed markets.
   *
   * @returns {Promise<{ passed: boolean, reason?: string, currentLine?: number }>}
   */
  async _runPreflightCheck({ sport, eventId, playerName, statType, bettingLine }) {
    try {
      const adapter = getAdapter(sport);
      const { line: currentLine, isAvailable } = await adapter.fetchCurrentLine(
        eventId,
        playerName,
        statType
      );

      // Market has closed (player scratched, prop removed, game started, etc.)
      if (!isAvailable || currentLine === null) {
        return { passed: false, reason: 'Market is no longer available', currentLine: null };
      }

      // Check if the line has moved significantly since the user saw it
      const lineChange = Math.abs(currentLine - bettingLine);
      if (lineChange > ODDS_CHANGE_THRESHOLD) {
        return {
          passed: false,
          reason: `Odds have changed (was ${bettingLine}, now ${currentLine})`,
          currentLine,
        };
      }

      return { passed: true, currentLine };
    } catch (err) {
      // If we can't verify odds (API down), fail safe — don't generate insight
      logger.error('[InsightService] Pre-flight check error', { error: err.message });
      return { passed: false, reason: 'Could not verify current odds. Please try again.' };
    }
  }

  // ─── OpenAI Call ──────────────────────────────────────────────────────────

  /**
   * Call OpenAI and return the response text + logging metadata.
   * Logs full input/output for debugging.
   *
   * @param {string} prompt
   * @param {Object} logContext - For structured logging
   * @returns {Promise<{ text: string, log: Object }>}
   */
  async _callOpenAI(prompt, logContext) {
    const startTime = Date.now();

    logger.info('🤖 [InsightService] Calling OpenAI...', logContext);

    // Log the full prompt in debug mode (useful for prompt engineering)
    logger.debug('🤖 [InsightService] OpenAI INPUT prompt', {
      ...logContext,
      prompt: prompt.substring(0, 500) + (prompt.length > 500 ? '...' : ''),
    });

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '800', 10),
      temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.3'),
      messages: [
        { role: 'system', content: AI_PROMPT.SYSTEM_ROLE },
        { role: 'user', content: prompt },
      ],
    });

    const latencyMs = Date.now() - startTime;
    const text = response.choices[0]?.message?.content || '';
    const tokensUsed = response.usage || {};
    const model = response.model;

    // Log the AI output (truncated for terminal, full stored in DB)
    logger.info('✅ [InsightService] OpenAI response received', {
      ...logContext,
      latencyMs,
      tokensTotal: tokensUsed.total_tokens,
      model,
    });

    logger.debug('🤖 [InsightService] OpenAI OUTPUT', {
      ...logContext,
      responsePreview: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
    });

    return {
      text,
      log: { tokensUsed, model, latencyMs },
    };
  }

  // ─── Parse AI Response ────────────────────────────────────────────────────

  /**
   * Extract structured data from the AI's free-text response.
   * Specifically extracts the OVER/UNDER recommendation.
   *
   * @param {string} text - Raw AI response text
   * @returns {{ recommendation: string|null }}
   */
  _parseAIResponse(text) {
    if (!text) return { recommendation: null };

    const upperText = text.toUpperCase();

    // Look for explicit OVER or UNDER in the response
    if (upperText.includes('OVER')) {
      return { recommendation: 'over' };
    } else if (upperText.includes('UNDER')) {
      return { recommendation: 'under' };
    }

    return { recommendation: null };
  }

  // ─── Strategy Score Calculation ───────────────────────────────────────────

  /**
   * Calculate confidence score, edge %, and filter tags.
   *
   * @param {Object} processedStats
   * @param {Object} parsed            - Parsed AI response
   * @param {number} bettingLine
   * @returns {{ confidenceScore, edgePercentage, isHighConfidence, isBestValue }}
   */
  _calculateStrategyScores(processedStats, parsed, bettingLine) {
    const { recentStatValues, focusStatAvg } = processedStats;

    // Confidence: how often the player has exceeded the line recently
    const direction = parsed.recommendation || 'over';
    let confidenceScore = 0;

    if (recentStatValues && recentStatValues.length > 0) {
      const hits = recentStatValues.filter((val) =>
        direction === 'over' ? val > bettingLine : val < bettingLine
      ).length;
      confidenceScore = Math.round((hits / recentStatValues.length) * 100);
    }

    // Edge: how far the average is from the line
    const edgePercentage = bettingLine > 0
      ? parseFloat(((focusStatAvg - bettingLine) / bettingLine) * 100).toFixed(2)
      : 0;

    // Tags for the filter system
    const { MIN_CONFIDENCE_HITS, CONFIDENCE_WINDOW, MIN_EDGE_PERCENTAGE } = require('../config/constants');
    const isHighConfidence = confidenceScore >= (MIN_CONFIDENCE_HITS / CONFIDENCE_WINDOW) * 100;
    const isBestValue = Math.abs(edgePercentage) >= MIN_EDGE_PERCENTAGE;

    return { confidenceScore, edgePercentage: parseFloat(edgePercentage), isHighConfidence, isBestValue };
  }

  // ─── Credit Deduction ─────────────────────────────────────────────────────

  /**
   * Deduct 1 credit from the user and log the transaction.
   * Called ONLY after successful insight generation.
   *
   * @param {Object} params
   */
  async _deductCredit({ user, insight, logContext }) {
    const newBalance = user.credits - CREDITS.COST_PER_INSIGHT;

    await User.findByIdAndUpdate(user._id, {
      $inc: { credits: -CREDITS.COST_PER_INSIGHT },
      $addToSet: { unlockedInsights: insight._id },
    });

    await Transaction.create({
      userId: user._id,
      type: TRANSACTION_TYPES.INSIGHT_UNLOCK,
      creditDelta: -CREDITS.COST_PER_INSIGHT,
      balanceAfter: newBalance,
      description: `Unlocked insight: ${insight.playerName} ${insight.statType} ${insight.bettingLine}`,
      insight: {
        insightId: insight._id,
        sport: insight.sport,
        playerName: insight.playerName,
        statType: insight.statType,
      },
    });

    logger.info('💳 [InsightService] Credit deducted', {
      ...logContext,
      creditDelta: -CREDITS.COST_PER_INSIGHT,
      newBalance,
    });
  }

  // ─── Refund ───────────────────────────────────────────────────────────────

  /**
   * Issue a credit refund when AI fails or player becomes unavailable.
   * This is called from the auto-refund system.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.insightId
   * @param {string} params.reason - Human-readable refund reason
   */
  async issueRefund({ userId, insightId, reason }) {
    const user = await User.findById(userId);
    if (!user) {
      logger.error('[InsightService] Refund failed — user not found', { userId });
      return;
    }

    const newBalance = user.credits + CREDITS.COST_PER_INSIGHT;

    await User.findByIdAndUpdate(userId, {
      $inc: { credits: CREDITS.COST_PER_INSIGHT },
    });

    await Transaction.create({
      userId,
      type: TRANSACTION_TYPES.REFUND,
      creditDelta: +CREDITS.COST_PER_INSIGHT,
      balanceAfter: newBalance,
      description: `Refund: ${reason}`,
      refundReason: reason,
      insight: insightId ? { insightId } : undefined,
    });

    logger.info('💰 [InsightService] Credit refund issued', { userId, insightId, reason, newBalance });
  }
}

module.exports = new InsightService(); // Singleton
/**
 * InsightService.js — AI insight generation engine
 *
 * Orchestrates the full pipeline: stats → formulas → OpenAI → MongoDB → credits.
 *
 * DATA SOURCES:
 *  Props/odds  → The Odds API Pro (DraftKings lines)
 *  NBA stats   → API-Sports NBA v2 (game logs, via apiSportsPlayerId on prop)
 *  MLB stats   → Official MLB Stats API (statsapi.mlb.com, lookup by playerName)
 *  Injuries    → injuryService (NBA: API-Sports | MLB: official MLB API)
 *  Game ctx    → gameContext.js (playoff detection, day game detection)
 *
 * PIPELINE (10 steps):
 *  1. MongoDB cold cache — return instantly if insight already exists
 *  2. Pre-flight odds check — abort if line moved significantly
 *  3. Fetch player game log (NBA: API-Sports by ID | MLB: official API by name)
 *  4. Apply sport formulas (NBAFormulas / MLBFormulas)
 *  5. Fetch injury context for prompt
 *  6. Detect game context (playoff? day game?) — SESSION 1 ADDITION
 *  7. Build sport-specific AI prompt (with game context injected)
 *  8. Call OpenAI (gpt-4o-mini, forced JSON output)
 *  9. Save insight to MongoDB
 * 10. Deduct 1 credit
 *
 * CREDIT RULES (strictly enforced):
 *  Never deduct if insight already cached (step 1 hit)
 *  Never deduct if pre-flight fails (step 2)
 *  Never deduct if OpenAI fails (step 8)
 */

const OpenAI       = require('openai');
const Insight      = require('../models/Insight.model');
const Transaction  = require('../models/Transaction.model');
const User         = require('../models/User.model');
const PlayerProp   = require('../models/PlayerProp.model');
const { Game }     = require('../models/Game.model');
const { cacheDel } = require('../config/redis');
const StrategyService = require('./StrategyService');
const PlayerStatsSnapshotService = require('./PlayerStatsSnapshotService');
const { getAdapter } = require('./shared/adapterRegistry');
const { getInjuryPromptContext, getPlayerInjuryStatus } = require('./injuryService');
// Sport-specific insight pipelines — each sport's context enrichment isolated
const SPORT_PIPELINES = {
  nba: require('./sports/nba/NBAInsightPipeline'),
  mlb: require('./sports/mlb/MLBInsightPipeline'),
  nhl: require('./sports/nhl/NHLInsightPipeline'),
};
const {
  INSIGHT_STATUS,
  ODDS_CHANGE_THRESHOLD,
  AI_PROMPT,
  CREDITS,
  TRANSACTION_TYPES,
} = require('../config/constants');
const logger = require('../config/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class InsightService {

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
    const logCtx = { sport, eventId, playerName, statType, bettingLine, userId: user._id };
    logger.info('🧠 [InsightService] Starting insight generation', logCtx);

    // ── STEP 1: MongoDB cold cache ─────────────────────────────────────────
    const existing = await Insight.findExisting({ sport, eventId, playerName, statType, bettingLine });
    if (existing) {
      logger.info('⚡ [InsightService] Cache HIT', logCtx);
      if (!user.hasUnlockedInsight(existing._id)) {
        await User.findByIdAndUpdate(user._id, { $addToSet: { unlockedInsights: existing._id } });
        await Insight.findByIdAndUpdate(existing._id, { $inc: { unlockCount: 1 } });
      }
      return { insight: existing, creditDeducted: false };
    }

    logger.info('💨 [InsightService] Cache MISS — generating', logCtx);

    // ── STEP 2: Pre-flight odds check ──────────────────────────────────────
    const preflight = await this._runPreflightCheck({ sport, eventId, playerName, statType, bettingLine });
    if (!preflight.passed) {
      logger.warn('🔴 [InsightService] Pre-flight FAILED', { ...logCtx, reason: preflight.reason });
      return { insight: null, creditDeducted: false, preflightFailed: true, reason: preflight.reason };
    }
    logger.info('✅ [InsightService] Pre-flight passed', logCtx);

    // ── STEP 3: Fetch player stats ─────────────────────────────────────────
    let rawStats   = [];
    let resolvedId = apiSportsPlayerId;
    const adapter  = getAdapter(sport);
    let prop       = null;

    try {
      prop = await PlayerProp.findOne({ oddsEventId: eventId, playerName, statType }).lean();

      if (sport === 'mlb') {
        rawStats = await PlayerStatsSnapshotService.getPlayerStats({
          sport,
          playerName,
          isPitcher: statType === 'pitcher_strikeouts',
        }) || [];
      } else if (sport === 'nhl') {
        // NHL: resolve player via team rosters from this game, then fetch official NHL game log.
        rawStats = await adapter.fetchPlayerStats({
          playerName,
          homeTeamName: prop?.homeTeamName || null,
          awayTeamName: prop?.awayTeamName || null,
        }) || [];
      } else {
        // NBA and others: use apiSportsPlayerId lookup
        if (!resolvedId) {
          resolvedId = prop?.apiSportsPlayerId || null;
        }
        if (resolvedId) {
          rawStats = await PlayerStatsSnapshotService.getPlayerStats({
            sport,
            playerName,
            playerId: resolvedId,
          }) || [];
        }
      }

      if (!rawStats.length) {
        logger.warn('[InsightService] No stats found — proceeding with empty data', logCtx);
      }
    } catch (statsErr) {
      logger.warn('[InsightService] Stats fetch failed — proceeding', {
        ...logCtx, error: statsErr.message,
      });
    }

    // ── STEP 4: Apply formulas ─────────────────────────────────────────────
    const processedStats = adapter.applyFormulas(
      rawStats, statType,
      { isPitcher: statType === 'pitcher_strikeouts' }
    );
    logger.debug('📐 [InsightService] Formulas applied', logCtx);

    // ── STEP 5: Injury context ─────────────────────────────────────────────
    let injuryContext = '';
    let storedInjuryStatus = null;
    let storedInjuryReason = null;
    let game = null;

    try {
      game = await Game.findOne({ oddsEventId: eventId }).lean();
      const teamCtx = {
        homeTeamName: game?.homeTeam?.name,
        awayTeamName: game?.awayTeam?.name,
      };
      injuryContext = await getInjuryPromptContext(playerName, teamCtx, sport);
      if (injuryContext) {
        const injData = await getPlayerInjuryStatus(playerName, teamCtx, sport);
        storedInjuryStatus = injData?.status || null;
        storedInjuryReason = injData?.reason || null;
        logger.info('[InsightService] Injury flag for player', { playerName, status: storedInjuryStatus });
      }
    } catch { /* non-fatal */ }

    // ── STEP 6: Sport-specific context enrichment ───────────────────────────
    // Each sport's pipeline is isolated in services/sports/{sport}/
    // NBAInsightPipeline: playoff detection + opponent defense
    // MLBInsightPipeline: starter inference + ballpark + platoon splits
    // NHLInsightPipeline: goalie matchup, team context (PP%, defense), playoff detection
    let sportCtx = {};
    try {
      const pipeline = SPORT_PIPELINES[sport];
      if (pipeline) {
        sportCtx = await pipeline.getInsightContext(
          {
            statType,
            playerName,
            oddsEventId:   eventId,
            homeTeamName:  prop.homeTeamName || game?.homeTeam?.name || null,
            awayTeamName:  prop.awayTeamName || game?.awayTeam?.name || null,
            playerTeam:    prop.playerTeam   || null,
          },
          game
        );
      }
    } catch { /* non-fatal — insight generates without sport context */ }

    // Unpack — each adapter.buildPrompt() receives the context keys it expects
    // NBA
    const gameContextData    = sportCtx.gameContext     || null;
    const defensiveContext   = sportCtx.defensiveContext || null;
    // MLB
    const starterContext     = sportCtx.starterContext   || null;
    const parkContext        = sportCtx.parkContext      || null;
    const platoonContext     = sportCtx.platoonContext   || null;
    // NHL
    const goalieContext      = sportCtx.goalieContext    || null;
    const teamContext        = sportCtx.teamContext      || null;
    const playerSide         = sportCtx.playerSide       || null;
    const isPlayoff          = sportCtx.isPlayoff        || false;

    // ── STEP 7: Build AI prompt ────────────────────────────────────────────
    const prompt = adapter.buildPrompt({
      processedStats,
      playerName,
      statType,
      bettingLine,
      marketType,
      injuryContext,
      isPitcher:        statType === 'pitcher_strikeouts',
      gameContext:      gameContextData,   // NBA: playoff detection
      starterContext:   starterContext,    // MLB: opponent starter matchup
      defensiveContext: defensiveContext,  // NBA: opponent defensive stats
      parkContext:      parkContext,       // MLB: ballpark factors
      platoonContext:   platoonContext,    // MLB: L/R platoon splits
      goalieContext,                       // NHL: opposing goalie SV% + tier
      teamContext,                         // NHL: PP%, shots-for/against, defense quality
      playerSide,                          // NHL: 'home' | 'away' for goalie assignment
      isPlayoff,                           // NHL: playoff pace adjustment
    });
    logger.debug('📝 [InsightService] Prompt built', { ...logCtx, promptLength: prompt.length });

    // ── STEP 8: Call OpenAI ────────────────────────────────────────────────
    let aiResponse, aiLog;
    try {
      aiResponse = await this._callOpenAI(prompt, logCtx);
      aiLog      = aiResponse.log;
    } catch (aiErr) {
      logger.error('❌ [InsightService] OpenAI failed', { ...logCtx, error: aiErr.message });
      return { insight: null, creditDeducted: false, error: 'AI generation failed. Please try again.' };
    }

    // ── STEP 9: Parse + score + save ──────────────────────────────────────
    const parsed = this._parseAIResponse(aiResponse.text);
    const { confidenceScore, edgePercentage, isHighConfidence, isBestValue } =
      this._calculateStrategyScores(processedStats, parsed, bettingLine, sport);

    const aiLogExpiresAt = new Date();
    aiLogExpiresAt.setDate(aiLogExpiresAt.getDate() + parseInt(process.env.AI_LOG_RETENTION_DAYS || '30', 10));

    const insight = await Insight.create({
      sport,
      eventId,
      playerName,
      statType,
      marketType,
      bettingLine,
      recommendation:    parsed.recommendation,
      injuryStatus:      storedInjuryStatus,
      injuryReason:      storedInjuryReason,
      insightSummary:    parsed.summary     || '',
      insightFactors:    parsed.factors     || [],
      insightRisks:      parsed.risks       || [],
      aiConfidenceLabel: parsed.confidence  || 'medium',
      dataQuality:       parsed.dataQuality || 'moderate',
      insightText:       aiResponse.text,
      // Stat fields for InsightModal panels — saved flat so frontend reads directly
      // NBA fields
      formPoints:         processedStats?.formPoints        ?? null,
      formRebounds:       processedStats?.formRebounds      ?? null,
      formAssists:        processedStats?.formAssists       ?? null,
      formThrees:         processedStats?.formThrees        ?? null,
      formPointsAssists:  processedStats?.formPointsAssists  ?? null,
      formMinutes:        processedStats?.formMinutes       ?? null,
      formGamesCount:     processedStats?.formGamesCount    ?? 5,
      baselineStatAvg:    processedStats?.baselineStatAvg   ?? null,
      baselineMinutes:    processedStats?.baselineMinutes   ?? null,
      baselineGamesCount: processedStats?.baselineGamesCount ?? 30,
      focusStatAvg:       processedStats?.focusStatAvg      ?? null,
      edgeGamesCount:     processedStats?.edgeGamesCount    ?? 10,
      trueShootingPct:    processedStats?.trueShootingPct   ?? null,
      effectiveFGPct:     processedStats?.effectiveFGPct    ?? null,
      approxUSGPct:       processedStats?.approxUSGPct      ?? null,
      // MLB batter fields (read by InsightModal StatWindows MLB panel)
      hitsPerG:           processedStats?.hitsPerG          ?? null,
      tbPerG:             processedStats?.tbPerG            ?? null,
      runsPerG:           processedStats?.runsPerG          ?? null,
      hrPerG:             processedStats?.hrPerG            ?? null,
      rbiPerG:            processedStats?.rbiPerG           ?? null,
      battingAvg:         processedStats?.battingAvg        ?? null,
      obp:                processedStats?.obp               ?? null,
      slg:                processedStats?.slg               ?? null,
      ops:                processedStats?.ops               ?? null,
      formStatAvg:        processedStats?.formStatAvg       ?? null,
      // MLB pitcher fields
      kPerStart:          processedStats?.kPerStart         ?? null,
      ipPerStart:         processedStats?.ipPerStart        ?? null,
      era:                processedStats?.era               ?? null,
      whip:               processedStats?.whip              ?? null,
      k9:                 processedStats?.k9                ?? null,
      formKPerStart:      processedStats?.formKPerStart     ?? null,
      // NHL skater fields
      goalsPerG:          processedStats?.goalsPerG          ?? null,
      assistsPerG:        processedStats?.assistsPerG        ?? null,
      pointsPerG:         processedStats?.pointsPerG         ?? null,
      shotsPerG:          processedStats?.shotsPerG          ?? null,
      toiPerG:            processedStats?.toiPerG            ?? null,
      formStatAvg:        processedStats?.formStatAvg        ?? null,
      // Session 1: store playoff context on insight
      isPlayoffGame:     gameContextData?.isPlayoff ?? false,
      playoffRound:      gameContextData?.round ?? null,
      confidenceScore,
      edgePercentage,
      isHighConfidence,
      isBestValue,
      status: INSIGHT_STATUS.GENERATED,
      oddsSnapshot: { line: preflight.currentLine, fetchedAt: new Date() },
      aiLog: {
        prompt,
        rawResponse:    aiResponse.text,
        tokensUsed:     aiLog.tokensUsed,
        model:          aiLog.model,
        latencyMs:      aiLog.latencyMs,
        processedStats,
        gameContext:    gameContextData,
      },
      aiLogExpiresAt,
      unlockCount: 1,
    });

    logger.info('✅ [InsightService] Insight saved', { ...logCtx, insightId: insight._id });

    // ── STEP 10: Deduct credit ─────────────────────────────────────────────
    await this._deductCredit({ user, insight, logCtx });

    return { insight: insight.toObject(), creditDeducted: true };
  }

  // ─── Pre-flight ────────────────────────────────────────────────────────────

  async _runPreflightCheck({ sport, eventId, playerName, statType, bettingLine }) {
    try {
      const adapter = getAdapter(sport);

      if (adapter.oddsApiQuotaRemaining === 0) {
        return { passed: false, reason: 'Live odds temporarily unavailable.', currentLine: null };
      }

      const { line: currentLine, isAvailable } = await adapter.fetchCurrentLine(eventId, playerName, statType);

      if (!isAvailable || currentLine === null) {
        await PlayerProp.updateOne(
          { sport, oddsEventId: eventId, playerName, statType, isAvailable: true },
          { $set: { isAvailable: false, lastUpdatedAt: new Date() } }
        );
        const gameDoc = await Game.findOne({ sport, oddsEventId: eventId }).select('startTime').lean();
        const keys = [`props:${sport}:${eventId}:all`, `props:${sport}:${eventId}:highConfidence`, `props:${sport}:${eventId}:bestValue`];
        if (gameDoc?.startTime) {
          keys.push(`schedule:${sport}:${new Date(gameDoc.startTime).toISOString().split('T')[0]}`);
        }
        await Promise.all(keys.map(k => cacheDel(k)));
        return { passed: false, reason: 'This prop is no longer available.', currentLine: null };
      }

      // Per-stat-type thresholds — tight lines (K props, goals) block on 0.5+ moves
      // Larger-variance stats (pts, rebounds) use the global ODDS_CHANGE_THRESHOLD
      const statThresholds = {
        pitcher_strikeouts: 0.5,
        threes:             0.5,
        goals:              0.5,
      };
      const effectiveThreshold = statThresholds[statType] ?? ODDS_CHANGE_THRESHOLD;
      const lineChange = Math.abs(currentLine - bettingLine);
      if (lineChange > effectiveThreshold) {
        return { passed: false, reason: `Odds have changed (was ${bettingLine}, now ${currentLine})`, currentLine };
      }

      return { passed: true, currentLine };
    } catch (err) {
      logger.error('[InsightService] Pre-flight error', { error: err.message });
      return { passed: false, reason: 'Could not verify current odds. Please try again.' };
    }
  }

  // ─── OpenAI ────────────────────────────────────────────────────────────────

  async _callOpenAI(prompt, logCtx) {
    const start = Date.now();
    logger.info('🤖 [InsightService] Calling OpenAI...', logCtx);

    const response = await openai.chat.completions.create({
      model:           process.env.OPENAI_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens:      parseInt(process.env.OPENAI_MAX_TOKENS  || '800', 10),
      temperature:     parseFloat(process.env.OPENAI_TEMPERATURE || '0.3'),
      messages: [
        { role: 'system', content: AI_PROMPT.SYSTEM_ROLE },
        { role: 'user',   content: prompt },
      ],
    });

    const latencyMs  = Date.now() - start;
    const text       = response.choices[0]?.message?.content || '';
    const tokensUsed = response.usage || {};
    const model      = response.model;

    logger.info('✅ [InsightService] OpenAI response', {
      ...logCtx, latencyMs, tokensTotal: tokensUsed.total_tokens, model,
    });

    return { text, log: { tokensUsed, model, latencyMs } };
  }

  // ─── Parse ─────────────────────────────────────────────────────────────────

  _parseAIResponse(text) {
    if (!text) return { recommendation: null };
    try {
      const clean  = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(clean);
      const rec    = parsed.recommendation?.toLowerCase();
      if (rec !== 'over' && rec !== 'under') {
        logger.warn('[InsightService] Invalid AI recommendation:', rec);
        return { recommendation: null };
      }
      return {
        recommendation: rec,
        confidence:     parsed.confidence  || 'medium',
        summary:        parsed.summary     || '',
        factors:        Array.isArray(parsed.factors) ? parsed.factors : [],
        risks:          Array.isArray(parsed.risks)   ? parsed.risks   : [],
        dataQuality:    parsed.dataQuality || 'moderate',
      };
    } catch (err) {
      logger.warn('[InsightService] AI JSON parse failed — text fallback', { error: err.message });
      const u = text.toUpperCase();
      const over  = (u.match(/\bOVER\b/g)  || []).length;
      const under = (u.match(/\bUNDER\b/g) || []).length;
      return { recommendation: over > under ? 'over' : under > over ? 'under' : null, dataQuality: 'weak' };
    }
  }

  // ─── Score calculation ─────────────────────────────────────────────────────

  _calculateStrategyScores(processedStats, parsed, bettingLine, sport = 'nba') {
    const scores = StrategyService.computeScores(processedStats, bettingLine, { sport });
    return {
      confidenceScore:  scores.confidenceScore,
      edgePercentage:   scores.edgePercentage,
      isHighConfidence: scores.isHighConfidence,
      isBestValue:      scores.isBestValue,
    };
  }

  // ─── Credit ────────────────────────────────────────────────────────────────

  async _deductCredit({ user, insight, logCtx }) {
    const newBalance = user.credits - CREDITS.COST_PER_INSIGHT;
    await User.findByIdAndUpdate(user._id, {
      $inc:     { credits: -CREDITS.COST_PER_INSIGHT },
      $addToSet: { unlockedInsights: insight._id },
    });
    await Transaction.create({
      userId:       user._id,
      type:         TRANSACTION_TYPES.INSIGHT_UNLOCK,
      creditDelta:  -CREDITS.COST_PER_INSIGHT,
      balanceAfter: newBalance,
      description:  `Insight: ${insight.playerName} ${insight.statType} ${insight.bettingLine}`,
      insight: {
        insightId:  insight._id,
        sport:      insight.sport,
        playerName: insight.playerName,
        statType:   insight.statType,
      },
    });
    logger.info('💳 [InsightService] Credit deducted', { ...logCtx, newBalance });
  }

  // ─── Refund ────────────────────────────────────────────────────────────────

  async issueRefund({ userId, insightId, reason }) {
    const user = await User.findById(userId);
    if (!user) { logger.error('[InsightService] Refund — user not found', { userId }); return; }
    const newBalance = user.credits + CREDITS.COST_PER_INSIGHT;
    await User.findByIdAndUpdate(userId, { $inc: { credits: CREDITS.COST_PER_INSIGHT } });
    await Transaction.create({
      userId,
      type:         TRANSACTION_TYPES.REFUND,
      creditDelta:  +CREDITS.COST_PER_INSIGHT,
      balanceAfter: newBalance,
      description:  `Refund: ${reason}`,
      refundReason: reason,
      insight:      insightId ? { insightId } : undefined,
    });
    logger.info('💰 [InsightService] Refund issued', { userId, insightId, reason, newBalance });
  }
}

module.exports = new InsightService();


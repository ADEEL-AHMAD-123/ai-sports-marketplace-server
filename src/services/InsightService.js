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
  nba:    require('./sports/nba/NBAInsightPipeline'),
  mlb:    require('./sports/mlb/MLBInsightPipeline'),
  nhl:    require('./sports/nhl/NHLInsightPipeline'),
  nfl:    require('./sports/nfl/NFLInsightPipeline'),
  soccer: require('./sports/soccer/SoccerInsightPipeline'),
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
      
      // Apply guardrails retroactively to cached insights
      // Track what changes so we can persist them back (findExisting uses .lean())
      const edgeAbs = Math.abs(existing.edgePercentage || 0);
      const guardrailUpdates = {};

      // Weak edge (<5%) cannot be high confidence
      if (edgeAbs < 5 && existing.isHighConfidence) {
        existing.isHighConfidence = false;
        guardrailUpdates.isHighConfidence = false;
        logger.debug('[InsightService] Applied HC guardrail to cache hit (weak edge)', logCtx);
      }
      // If data quality is 'strong' but edge is weak (<5%), downgrade to moderate
      if (edgeAbs < 5 && existing.dataQuality === 'strong') {
        existing.dataQuality = 'moderate';
        guardrailUpdates.dataQuality = 'moderate';
        logger.debug('[InsightService] Applied dataQuality guardrail to cache hit (strong quality on weak edge)', logCtx);
      }
      // Weak edge (<5%) cannot have high confidence score
      if (edgeAbs < 5 && existing.confidenceScore > 55) {
        existing.confidenceScore = 55;
        guardrailUpdates.confidenceScore = 55;
        logger.debug('[InsightService] Applied confidence cap guardrail to cache hit (weak edge)', logCtx);
      }
      // Zero/near-zero edge (<0.5%) is no predictive edge — cap severely
      if (edgeAbs < 0.5 && existing.confidenceScore > 30) {
        existing.confidenceScore = 30;
        existing.isHighConfidence = false;
        guardrailUpdates.confidenceScore = 30;
        guardrailUpdates.isHighConfidence = false;
        logger.debug('[InsightService] Applied zero-edge guardrail to cache hit', logCtx);
      }

      // Extreme-edge outlier: edge >80% on thin baseline (<20 games) → downgrade quality
      const existingBaseline = existing.baselineGamesCount ?? 30;
      if (edgeAbs > 80 && existingBaseline < 20 && existing.dataQuality === 'strong') {
        existing.dataQuality = 'moderate';
        guardrailUpdates.dataQuality = 'moderate';
        logger.debug('[InsightService] Applied outlier-edge guardrail to cache hit (extreme edge + thin baseline)', logCtx);
      }

      // Persist guardrail corrections back to DB (lean() object is not auto-saved)
      if (Object.keys(guardrailUpdates).length > 0) {
        await Insight.findByIdAndUpdate(existing._id, { $set: guardrailUpdates });
        logger.info('[InsightService] Persisted guardrail corrections to DB', { ...logCtx, guardrailUpdates });
      }
      
      // Try to refresh leagueContext with fresh game + sport context
      try {
        const game = await Game.findOne({ sport, oddsEventId: eventId }).lean();
        const prop = await PlayerProp.findOne({ sport, oddsEventId: eventId, playerName, statType }).lean();
        if (game && prop) {
          const freshSportCtx = await this._getSportContext(sport, eventId, prop, game);
          existing.leagueContext = this._buildLeagueContext({ sport, prop, game, sportCtx: freshSportCtx });
          logger.debug('[InsightService] Refreshed leagueContext on cache hit', logCtx);
        }
      } catch (err) {
        logger.debug('[InsightService] Cache leagueContext refresh skipped (non-critical)', { error: err.message });
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
    // Pre-fetch game so soccer can use leagueId here; reused in Step 5 without a second DB hit.
    let game = null;
    try { game = await Game.findOne({ sport, oddsEventId: eventId }).lean(); } catch { /* non-fatal */ }

    try {
      prop = await PlayerProp.findOne({ sport, oddsEventId: eventId, playerName, statType }).lean();

      if (sport === 'mlb') {
        rawStats = await PlayerStatsSnapshotService.getPlayerStats({
          sport,
          playerName,
          isPitcher: statType === 'pitcher_strikeouts',
        }) || [];
      } else if (sport === 'nhl') {
        // Pass team names so the NHL roster resolver can identify the player on first fetch.
        rawStats = await PlayerStatsSnapshotService.getPlayerStats({
          sport,
          playerName,
          homeTeamName: prop?.homeTeamName || game?.homeTeam?.name || null,
          awayTeamName: prop?.awayTeamName || game?.awayTeam?.name || null,
        }) || [];
      } else if (sport === 'soccer') {
        rawStats = await PlayerStatsSnapshotService.getPlayerStats({
          sport,
          playerName,
          homeTeamName: prop?.homeTeamName || game?.homeTeam?.name || null,
          awayTeamName: prop?.awayTeamName || game?.awayTeam?.name || null,
          leagueId: game?.leagueId || null,
        }) || [];
      } else {
        // NBA, NFL, and others: use apiSportsPlayerId lookup
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
    // For NHL, derive opposing team abbrev + player position so head-to-head,
    // home/away splits, and position-aware TOI thresholds compute correctly.
    let formulaContext = { isPitcher: statType === 'pitcher_strikeouts' };
    if (sport === 'nhl') {
      try {
        const NHLStatsClient = require('./sports/nhl/NHLStatsClient');
        const playerTeam     = prop?.playerTeam || null;       // 'home' | 'away' | null
        let opposingTeamName = null;
        if (playerTeam === 'home')      opposingTeamName = prop?.awayTeamName;
        else if (playerTeam === 'away') opposingTeamName = prop?.homeTeamName;
        const opposingTeamAbbrev = opposingTeamName
          ? NHLStatsClient.getTeamAbbrev(opposingTeamName)
          : null;
        const position = rawStats?.__playerInfo?.position || null;
        formulaContext = {
          ...formulaContext,
          opposingTeamAbbrev,
          playerSide: playerTeam,
          position,
        };
      } catch (e) {
        logger.debug('[InsightService] NHL formula context derive failed (non-fatal)', { error: e.message });
      }
    }
    const processedStats = adapter.applyFormulas(rawStats, statType, formulaContext);
    logger.debug('📐 [InsightService] Formulas applied', logCtx);

    // ── STEP 5: Injury context ─────────────────────────────────────────────
    let injuryContext = '';
    let storedInjuryStatus = null;
    let storedInjuryReason = null;
    // game was pre-fetched before Step 3; only re-fetch if that attempt failed.

    try {
      if (!game) game = await Game.findOne({ sport, oddsEventId: eventId }).lean();
      const teamCtx = {
        leagueId: game?.leagueId,
        homeTeamName: game?.homeTeam?.name,
        awayTeamName: game?.awayTeam?.name,
        homeTeamApiSportsId: game?.homeTeam?.apiSportsId,
        awayTeamApiSportsId: game?.awayTeam?.apiSportsId,
        startTime: game?.startTime,
        oddsEventId: eventId,
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
    const hasReliableNhlSide = sport !== 'nhl' || playerSide === 'home' || playerSide === 'away';
    const isPlayoff          = sportCtx.isPlayoff        || false;
    const isBackToBack       = sportCtx.isBackToBack     || false;

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
      goalieContext: hasReliableNhlSide ? goalieContext : null, // NHL: only when side is confirmed
      teamContext,                         // NHL: PP%, shots-for/against, defense quality
      playerSide,                          // NHL: 'home' | 'away' for goalie assignment
      isPlayoff,                           // NHL: playoff pace adjustment
      isBackToBack,                        // NHL: opposing team on second half of B2B
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
    let parsed = this._parseAIResponse(aiResponse.text);
    const { confidenceScore, edgePercentage, isHighConfidence, isBestValue } =
      this._calculateStrategyScores(processedStats, parsed, bettingLine, sport);
    parsed = this._sanitizeParsedNarrative({
      sport,
      statType,
      parsed,
      processedStats,
      confidenceScore,
      edgePercentage,
      bettingLine,
    });
    const recommendation = this._resolveRecommendation(parsed.recommendation, edgePercentage);

    const aiLogExpiresAt = new Date();
    aiLogExpiresAt.setDate(aiLogExpiresAt.getDate() + parseInt(process.env.AI_LOG_RETENTION_DAYS || '30', 10));

    const insight = await Insight.create({
      sport,
      eventId,
      playerName,
      statType,
      marketType,
      bettingLine,
      recommendation,
      injuryStatus:      storedInjuryStatus,
      injuryReason:      storedInjuryReason,
      insightSummary:    parsed.summary     || '',
      insightFactors:    parsed.factors     || [],
      insightRisks:      parsed.risks       || [],
      aiConfidenceLabel: parsed.confidence  || 'medium',
      // Guardrail: if baseline is partial (< 30 games), downgrade to moderate
      // Guardrail: extreme edge (>80%) on a thin baseline (<20 games) is likely an outlier — downgrade
      dataQuality: (() => {
        const q = parsed.dataQuality || 'moderate';
        const baseline = processedStats?.baselineGamesCount ?? 30;
        const absEd = Math.abs(scores?.edgePercentage ?? 0);
        if (q === 'strong' && baseline < 30) return 'moderate';
        if (q === 'strong' && absEd > 80 && baseline < 20) return 'moderate';
        return q;
      })(),
      insightText:       aiResponse.text,
      // Stat fields for InsightModal panels — saved flat so frontend reads directly
      // NBA fields
      formPoints:         processedStats?.formPoints        ?? null,
      formRebounds:       processedStats?.formRebounds      ?? null,
      formAssists:        processedStats?.formAssists       ?? null,
      formThrees:         processedStats?.formThrees        ?? null,
      formPointsAssists:  processedStats?.formPointsAssists  ?? null,
      formMinutes:        processedStats?.formMinutes       ?? null,
      avgPlusMinus:       processedStats?.avgPlusMinus      ?? null,
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
      // NHL skater fields — per-game averages
      goalsPerG:          processedStats?.goalsPerG          ?? null,
      assistsPerG:        processedStats?.assistsPerG        ?? null,
      pointsPerG:         processedStats?.pointsPerG         ?? null,
      shotsPerG:          processedStats?.shotsPerG          ?? null,
      toiPerG:            processedStats?.toiPerG            ?? null,
      ppgPerG:            processedStats?.ppgPerG            ?? null,
      pmPerG:             processedStats?.pmPerG             ?? null,
      esGoalsPerG:        processedStats?.esGoalsPerG        ?? null,
      ppGoalsPerG:        processedStats?.ppGoalsPerG        ?? null,
      // NHL — splits
      homeStatAvg:        processedStats?.homeStatAvg        ?? null,
      awayStatAvg:        processedStats?.awayStatAvg        ?? null,
      homeGames:          processedStats?.homeGames          ?? null,
      awayGames:          processedStats?.awayGames          ?? null,
      h2hStatAvg:         processedStats?.h2hStatAvg         ?? null,
      h2hCount:           processedStats?.h2hCount           ?? null,
      opposingTeamAbbrev: processedStats?.opposingTeamAbbrev ?? null,
      formWindowSize:     processedStats?.formWindowSize     ?? null,
      // NHL — season composition (playoff blending)
      playoffGameCount:   processedStats?.playoffGameCount   ?? null,
      regularGameCount:   processedStats?.regularGameCount   ?? null,
      isMixedSeason:      processedStats?.isMixedSeason      ?? false,
      formMix:            processedStats?.formMix            ?? null,
      edgeMix:            processedStats?.edgeMix            ?? null,
      baselineMix:        processedStats?.baselineMix        ?? null,
      // NHL — quality flags
      tooThin:            processedStats?.tooThin            ?? false,
      forceConfidence:    processedStats?.forceConfidence    ?? null,
      hasInconsistentTOI: processedStats?.hasInconsistentTOI ?? false,
      toiCV:              processedStats?.toiCV              ?? null,
      toiCVThreshold:     processedStats?.toiCVThreshold     ?? null,
      lineTier:           processedStats?.lineTier           ?? null,
      position:           processedStats?.position           ?? null,
      // NHL — scoring profile
      ppDependencyPct:    processedStats?.ppDependencyPct    ?? null,
      isPPDependent:      processedStats?.isPPDependent      ?? false,
      shootingPct:        processedStats?.shootingPct        ?? null,
      onGoalStreak:       processedStats?.onGoalStreak       ?? false,
      onGoalSlump:        processedStats?.onGoalSlump        ?? false,
      formGoals:          processedStats?.formGoals          ?? null,
      edgeGoals:          processedStats?.edgeGoals          ?? null,
      // NHL — matchup flags from pipeline
      isPlayoff:          (sport === 'nhl' ? (sportCtx?.isPlayoff ?? false) : false),
      isBackToBack:       (sport === 'nhl' ? (sportCtx?.isBackToBack ?? false) : false),
      playerTeam:         (sport === 'nhl' ? (sportCtx?.playerSide ?? prop?.playerTeam ?? null) : null),
      // Session 1: store playoff context on insight (NBA flag — kept for back-compat)
      isPlayoffGame:     gameContextData?.isPlayoff ?? (sport === 'nhl' ? (sportCtx?.isPlayoff ?? false) : false),
      playoffRound:      gameContextData?.round ?? null,
      confidenceScore,
      edgePercentage,
      isHighConfidence,
      isBestValue,
      status: INSIGHT_STATUS.GENERATED,
      oddsSnapshot: { line: preflight.currentLine, fetchedAt: new Date() },
      // ── Game-personalization payload (read by InsightModal sub-blocks) ───
      // Survives every read path (controllers strip aiLog, not leagueContext).
      leagueContext: this._buildLeagueContext({ sport, prop, game, sportCtx }),
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

  // ─── Game-personalization payload ──────────────────────────────────────────
  // Builds Insight.leagueContext — the structured per-game payload the
  // frontend modal uses to render opponent / venue / matchup specifics.
  // Sport-aware; safe to call with partial inputs.
  _buildLeagueContext({ sport, prop, game, sportCtx }) {
    if (!game) return null;
    const homeName     = game.homeTeam?.name || null;
    const awayName     = game.awayTeam?.name || null;
    const homeAbbr     = game.homeTeam?.abbreviation || null;
    const awayAbbr     = game.awayTeam?.abbreviation || null;
    const propTeamAbbr = String(prop?.teamName || '').trim().toUpperCase() || null;
    const inferredSide = propTeamAbbr && homeAbbr && awayAbbr
      ? (propTeamAbbr === String(homeAbbr).toUpperCase() ? 'home'
        : propTeamAbbr === String(awayAbbr).toUpperCase() ? 'away'
        : null)
      : null;
    const rawSide = sportCtx?.playerSide || prop?.playerTeam || inferredSide || null;
    const playerSide = rawSide === 'home' || rawSide === 'away' ? rawSide : null;
    const opponentName = playerSide === 'home' ? awayName
                       : playerSide === 'away' ? homeName : null;
    const opponentAbbr = playerSide === 'home' ? awayAbbr
                       : playerSide === 'away' ? homeAbbr : null;

    const base = {
      sport,
      gameStartTime:   game.startTime || null,
      homeTeam:        homeName,
      awayTeam:        awayName,
      homeAbbr,
      awayAbbr,
      playerSide,                                  // 'home' | 'away' | null
      venue:           playerSide === 'home' ? 'home' : playerSide === 'away' ? 'away' : null,
      opponentName,
      opponentAbbr,
    };

    if (sport === 'nhl') {
      const statType = String(prop?.statType || '').toLowerCase();
      const goalieRelevantStats = new Set(['goals', 'shots_on_goal']);
      const shouldShowGoalie = goalieRelevantStats.has(statType);
      const rawGoalie = sportCtx?.goalieContext
        ? (playerSide === 'home' ? sportCtx.goalieContext.awayGoalie
          : playerSide === 'away' ? sportCtx.goalieContext.homeGoalie
          : null)
        : null;
      const goalieTeamAbbr = rawGoalie?.teamAbbrev ? String(rawGoalie.teamAbbrev).toUpperCase() : null;
      const expectedOppAbbr = opponentAbbr ? String(opponentAbbr).toUpperCase() : null;
      // Guardrail: suppress goalie context if the resolved goalie doesn't belong
      // to the inferred opponent team for this player/game.
      const goalie = (!shouldShowGoalie)
        ? null
        : (!rawGoalie || !goalieTeamAbbr || !expectedOppAbbr || goalieTeamAbbr === expectedOppAbbr)
        ? rawGoalie
        : null;
      const team = sportCtx?.teamContext || null;
      const oppTeamStats = team
        ? (playerSide === 'home' ? team.away : playerSide === 'away' ? team.home : null)
        : null;
      return {
        ...base,
        isPlayoff:    !!sportCtx?.isPlayoff,
        isBackToBack: !!sportCtx?.isBackToBack,
        goalie: goalie ? {
          name:            goalie.name || null,
          teamAbbrev:      goalie.teamAbbrev || null,
          tier:            goalie.tier || null,
          seasonTier:      goalie.seasonTier || null,
          savePercentage:  goalie.savePercentage ?? null,
          goalsAgainstAvg: goalie.goalsAgainstAvg ?? null,
          gamesPlayed:     goalie.gamesPlayed ?? null,
          recentSavePct:   goalie.recentForm?.recentSavePct ?? null,
          recentStarts:    goalie.recentForm?.startsCount ?? null,
          isHot:           !!goalie.recentForm?.isHot,
          isCold:          !!goalie.recentForm?.isCold,
        } : null,
        oppTeam: oppTeamStats ? {
          ppPct:               oppTeamStats.ppPct ?? null,
          pkPct:               oppTeamStats.pkPct ?? null,
          shotsAgainstPerGame: oppTeamStats.shotsAgainstPerGame ?? null,
          goalsAgainstPerGame: oppTeamStats.goalsAgainstPerGame ?? null,
        } : null,
        expectedShots: team?.expectedPace
          ? (playerSide === 'home' ? team.expectedPace.homeExpectedShots
            : playerSide === 'away' ? team.expectedPace.awayExpectedShots
            : null)
          : null,
      };
    }

    if (sport === 'nba') {
      const def = sportCtx?.defensiveContext || null;
      const oppDef = def && (playerSide === 'home' || playerSide === 'away')
        ? (playerSide === 'home' ? def.awayTeamDef : def.homeTeamDef)
        : null;
      return {
        ...base,
        isPlayoff:  !!sportCtx?.gameContext?.isPlayoff,
        round:      sportCtx?.gameContext?.round || null,
        gameNumber: sportCtx?.gameContext?.gameNumber || null,
        oppDefense: oppDef ? {
          pointsAllowedPG:   oppDef.pointsAllowedPG ?? null,
          threesAllowedPG:   oppDef.threesAllowedPG ?? null,
          reboundsAllowedPG: oppDef.reboundsAllowedPG ?? null,
          gamesPlayed:       oppDef.gamesPlayed ?? null,
          teamName:          oppDef.teamName || null,
        } : null,
      };
    }

    if (sport === 'mlb') {
      const starter = sportCtx?.starterContext?.starterStats || null;
      return {
        ...base,
        starter: sportCtx?.starterContext ? {
          name:  sportCtx.starterContext.starterName || null,
          hand:  starter?.hand || starter?.handedness || null,
          era:   starter?.era ?? null,
          whip:  starter?.whip ?? null,
          k9:    starter?.k9 ?? null,
        } : null,
        ballpark: sportCtx?.parkContext ? {
          homeTeamName: sportCtx.parkContext.homeTeamName,
        } : null,
        platoon: sportCtx?.platoonContext?.matchup
          ? {
              batterHand:  sportCtx.platoonContext.matchup.batterHand  || null,
              pitcherHand: sportCtx.platoonContext.matchup.pitcherHand || null,
              edge:        sportCtx.platoonContext.matchup.edge        || null,
              note:        sportCtx.platoonContext.matchup.note        || null,
            }
          : null,
      };
    }

    return base;
  }

  async refreshExistingInsightContext(insight) {
    if (!insight?.sport || !insight?.eventId) return insight;

    const pipeline = SPORT_PIPELINES[insight.sport];
    if (!pipeline?.getInsightContext) return insight;

    try {
      const game = await Game.findOne({ sport: insight.sport, oddsEventId: insight.eventId }).lean();
      if (!game) return insight;

      const prop = await PlayerProp.findOne({
        sport: insight.sport,
        oddsEventId: insight.eventId,
        playerName: insight.playerName,
        statType: insight.statType,
      }).lean();
      if (!prop) return insight;

      const sportCtx = await pipeline.getInsightContext(prop, game).catch(() => null);
      if (!sportCtx) return insight;

      const leagueContext = this._buildLeagueContext({
        sport: insight.sport,
        prop,
        game,
        sportCtx,
      });

      if (!leagueContext) return insight;

      const patch = {
        leagueContext,
        isPlayoff: !!sportCtx?.isPlayoff,
      };
      const recommendation = this._resolveRecommendation(insight.recommendation, insight.edgePercentage);
      if (recommendation && recommendation !== insight.recommendation) {
        patch.recommendation = recommendation;
      }
      const normalizedCertainty = this._normalizeAiCertaintyBySignal(
        insight.confidenceScore,
        insight.aiConfidenceLabel
      );
      if (normalizedCertainty && normalizedCertainty !== insight.aiConfidenceLabel) {
        patch.aiConfidenceLabel = normalizedCertainty;
      }
      const sanitizedNarrative = this._sanitizeExistingNarrative(insight);
      if (sanitizedNarrative.summary !== insight.insightSummary) {
        patch.insightSummary = sanitizedNarrative.summary;
      }
      if (JSON.stringify(sanitizedNarrative.factors) !== JSON.stringify(insight.insightFactors || [])) {
        patch.insightFactors = sanitizedNarrative.factors;
      }
      if (insight.sport === 'nhl') {
        patch.isBackToBack = !!sportCtx?.isBackToBack;
        patch.playerTeam = sportCtx?.playerSide || prop?.playerTeam || insight.playerTeam || null;
      }

      const updated = await Insight.findByIdAndUpdate(
        insight._id,
        { $set: patch },
        { new: true }
      ).lean();

      return updated || { ...insight, ...patch };
    } catch (err) {
      logger.debug('[InsightService] refreshExistingInsightContext skipped', {
        insightId: insight?._id,
        sport: insight?.sport,
        error: err.message,
      });
      return insight;
    }
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
      // Soccer uses 1.0 since lower-liquidity markets have higher volatility
      const statThresholds = {
        pitcher_strikeouts: 0.5,
        threes:             0.5,
        goals:              1.0,  // Soccer goals: increased from 0.5 to 1.0 for volatile markets
        assists:            1.0,  // Soccer assists: use global threshold
        shots_on_target:    1.0,  // Soccer shots: use global threshold
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

  _normalizeAiCertaintyBySignal(confidenceScore, label) {
    const raw = String(label || 'medium').toLowerCase();
    const normalized = ['low', 'medium', 'high'].includes(raw) ? raw : 'medium';
    if (!Number.isFinite(confidenceScore)) return normalized;
    if (confidenceScore < 35) return 'low';
    if (confidenceScore < 60 && normalized === 'high') return 'medium';
    return normalized;
  }

  _sanitizeParsedNarrative({
    sport,
    statType,
    parsed,
    processedStats,
    confidenceScore,
    edgePercentage,
    bettingLine,
  }) {
    const next = {
      ...parsed,
      factors: Array.isArray(parsed?.factors) ? [...parsed.factors] : [],
    };

    next.confidence = this._normalizeAiCertaintyBySignal(confidenceScore, parsed?.confidence);

    const weakSignal = (Number.isFinite(edgePercentage) && Math.abs(edgePercentage) < 8)
      || (Number.isFinite(confidenceScore) && confidenceScore < 45);
    if (weakSignal && typeof next.summary === 'string' && next.summary) {
      next.summary = next.summary
        .replace(/\bstrong\s+(under|over)\s+signal\b/gi, '$1 lean')
        .replace(/\bstrong\s+signal\b/gi, 'lean')
        .replace(/\bstrongly\b/gi, 'moderately');
    }

    if (sport === 'nhl') {
      const type = String(statType || '').toLowerCase();
      if (type === 'assists' || type === 'points') {
        next.factors = next.factors.filter((f) => !/goalie/i.test(String(f || '')));
      }

      const form5 = Number(processedStats?.formStatAvg);
      const form10 = Number(processedStats?.focusStatAvg);
      const baseline = Number(processedStats?.baselineStatAvg);
      const hasUpTrend = (Number.isFinite(form5) && Number.isFinite(form10) && form5 > form10)
        || (Number.isFinite(form5) && Number.isFinite(baseline) && form5 > baseline);

      if (hasUpTrend) {
        next.factors = next.factors.filter((f) => !/(decline|downward|trending\s+down|falling|below\s+baseline)/i.test(String(f || '')));
      }

      if (!next.factors.length && Number.isFinite(form5) && Number.isFinite(bettingLine)) {
        const leanWord = form5 >= bettingLine ? 'over' : 'under';
        next.factors.push(`recent ${type || 'form'} trend leans ${leanWord.toUpperCase()} (${form5.toFixed(2)} vs line ${bettingLine})`);
      }
    }

    return next;
  }

  _sanitizeExistingNarrative(insight) {
    const factors = Array.isArray(insight?.insightFactors) ? [...insight.insightFactors] : [];
    const weakSignal = (Number.isFinite(insight?.edgePercentage) && Math.abs(insight.edgePercentage) < 8)
      || (Number.isFinite(insight?.confidenceScore) && insight.confidenceScore < 45);
    let summary = String(insight?.insightSummary || '');

    if (weakSignal && summary) {
      summary = summary
        .replace(/\bstrong\s+(under|over)\s+signal\b/gi, '$1 lean')
        .replace(/\bstrong\s+signal\b/gi, 'lean')
        .replace(/\bstrongly\b/gi, 'moderately');
    }

    if (insight?.sport === 'nhl') {
      const type = String(insight?.statType || '').toLowerCase();
      let nextFactors = factors;
      if (type === 'assists' || type === 'points') {
        nextFactors = nextFactors.filter((f) => !/goalie/i.test(String(f || '')));
      }

      const form5 = Number(insight?.formStatAvg);
      const form10 = Number(insight?.focusStatAvg);
      const baseline = Number(insight?.baselineStatAvg);
      const hasUpTrend = (Number.isFinite(form5) && Number.isFinite(form10) && form5 > form10)
        || (Number.isFinite(form5) && Number.isFinite(baseline) && form5 > baseline);

      if (hasUpTrend) {
        nextFactors = nextFactors.filter((f) => !/(decline|downward|trending\s+down|falling|below\s+baseline)/i.test(String(f || '')));
      }

      return { summary, factors: nextFactors };
    }

    return { summary, factors };
  }

  _resolveRecommendation(currentRecommendation, edgePercentage) {
    const rec = typeof currentRecommendation === 'string'
      ? currentRecommendation.toLowerCase()
      : null;

    if (!Number.isFinite(edgePercentage)) return rec;
    if (edgePercentage > 0) return 'over';
    if (edgePercentage < 0) return 'under';
    return rec;
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


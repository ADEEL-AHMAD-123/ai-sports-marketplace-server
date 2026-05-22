/**
 * nfl.postGameSync.js — NFL-only game lifecycle + outcome grading
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp = require('../../../models/PlayerProp.model');
const Insight = require('../../../models/Insight.model');
const TeamGameResult = require('../../../models/TeamGameResult.model');
const { gradeEvents } = require('../../../services/queue/OutcomeDispatcherService');
const PlayerStatsSnapshotService = require('../../../services/PlayerStatsSnapshotService');
const { getAdapter } = require('../../../services/shared/adapterRegistry');
const { cacheDel } = require('../../../config/redis');
const { shouldFetchScores } = require('../shared/scorePollingPolicy');
const logger = require('../../../config/logger');

const SPORT = 'nfl';
const FINALIZE_AFTER_HOURS = Number(process.env.NFL_FINALIZE_AFTER_HOURS || process.env.POST_GAME_FINALIZE_AFTER_HOURS || 3.5);
const STALE_DELETE_AFTER_HOURS = Number(process.env.NFL_STALE_DELETE_AFTER_HOURS || process.env.POST_GAME_STALE_DELETE_AFTER_HOURS || 30);
const OUTCOME_MAX_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.OUTCOME_MAX_RETRY_ATTEMPTS || '12', 10));

// Last successful /scores call — module-level so the score-polling policy can
// throttle across cron cycles within the process.
let lastScoreFetchAt = null;

async function run() {
  logger.info('🔄 [NFLPostGameSync] Starting...');

  const now = new Date();
  const finalizeCutoff = new Date(now - FINALIZE_AFTER_HOURS * 3600000);
  const staleCutoff = new Date(now - STALE_DELETE_AFTER_HOURS * 3600000);
  const todayKey = now.toISOString().split('T')[0];
  let changes = 0;

  // One /scores call powers both final-detection and result capture — fetched
  // below, gated by the score policy.
  let providerFinalEventIds = new Set();
  const scoresByEventId = new Map();

  const toLive = await Game.find({
    sport: SPORT,
    status: GAME_STATUS.SCHEDULED,
    startTime: { $lte: now },
  }).lean();

  if (toLive.length) {
    await Game.updateMany({ _id: { $in: toLive.map((g) => g._id) } }, { $set: { status: GAME_STATUS.LIVE } });
    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    changes += toLive.length;
  }

  const liveGames = await Game.find({ sport: SPORT, status: GAME_STATUS.LIVE }).lean();

  // Provider scores — only call /scores when a started game is plausibly
  // finishing, throttled by the score-polling policy. When skipped, the
  // time-based finalize still works and result capture simply waits a cycle.
  if (shouldFetchScores(liveGames, now, lastScoreFetchAt)) {
    try {
      const adapter = getAdapter(SPORT);
      const finalScores = (await adapter.fetchFinalScores?.({ daysFrom: 3 })) || [];
      for (const s of finalScores) {
        if (!s?.eventId) continue;
        scoresByEventId.set(String(s.eventId), s);
        if (s.completed) providerFinalEventIds.add(String(s.eventId));
      }
      lastScoreFetchAt = now;
    } catch (err) {
      logger.warn('[NFLPostGameSync] Provider score check unavailable', { error: err.message });
    }
  }

  const toFinal = liveGames.filter((g) => {
    const isTimeFinal = new Date(g.startTime) <= finalizeCutoff;
    const isProviderFinal = g.oddsEventId && providerFinalEventIds.has(String(g.oddsEventId));
    return isTimeFinal || isProviderFinal;
  });

  if (toFinal.length) {
    await Game.updateMany({ _id: { $in: toFinal.map((g) => g._id) } }, { $set: { status: GAME_STATUS.FINAL } });
    await PlayerProp.updateMany({ gameId: { $in: toFinal.map((g) => g._id) } }, { $set: { isAvailable: false } });

    const finalEventIds = toFinal.map((g) => g.oddsEventId).filter(Boolean);
    await gradeEvents(finalEventIds, { sport: SPORT, source: 'nfl.postGameSync.finalize' });
    await PlayerStatsSnapshotService.markSportSnapshotsStale(SPORT);

    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    for (const game of toFinal) {
      for (const suffix of ['all', 'highConfidence', 'bestValue']) {
        await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
      }
    }

    changes += toFinal.length;
  }

  // ── CAPTURE RESULTS — persist finalized scores for team-form history ──────
  // TeamGameResult outlives the 30h Game stale-delete, so NFLInsightPipeline
  // can compute real team form & rest-days. Idempotent (keyed upsert).
  await _captureTeamResults(scoresByEventId);

  const finalGames = await Game.find({ sport: SPORT, status: GAME_STATUS.FINAL })
    .select('_id oddsEventId')
    .lean();
  if (finalGames.length) {
    const ids = finalGames.map((g) => g.oddsEventId).filter(Boolean);
    const unresolvedCount = await Insight.countDocuments({
      eventId: { $in: ids },
      status: 'generated',
      outcomeResult: { $in: ['unresolved', null] },
    });
    if (unresolvedCount > 0) {
      await gradeEvents(ids, { sport: SPORT, source: 'nfl.postGameSync.regrade' });
    }
  }

  const stale = await Game.find({ sport: SPORT, status: GAME_STATUS.FINAL, startTime: { $lte: staleCutoff } })
    .select('_id oddsEventId')
    .lean();

  let deleted = 0;
  if (stale.length) {
    const staleEventIds = stale.map((g) => g.oddsEventId).filter(Boolean);

    await gradeEvents(staleEventIds, { sport: SPORT, source: 'nfl.postGameSync.stale' });

    await Insight.updateMany(
      {
        eventId: { $in: staleEventIds },
        outcomeResult: { $in: ['unresolved', null] },
        outcomeAttempts: { $gte: OUTCOME_MAX_RETRY_ATTEMPTS },
        outcomeReason: { $in: ['game_not_found', 'player_not_found', 'retry_exhausted', 'unsupported_sport'] },
      },
      {
        $set: {
          outcomeResult: 'void',
          outcomeReason: 'void_retry_exhausted',
          outcomeGradedAt: new Date(),
          outcomeNextRetryAt: null,
        },
      }
    );

    const staleIds = stale.map((g) => g._id);
    await PlayerProp.deleteMany({ gameId: { $in: staleIds } });
    await Game.deleteMany({ _id: { $in: staleIds } });

    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    await cacheDel(`schedule:${SPORT}:${new Date(Date.now() - 86400000).toISOString().split('T')[0]}`);

    deleted = stale.length;
  }

  logger.info('✅ [NFLPostGameSync] Done', {
    changes,
    deleted,
    providerFinalCount: providerFinalEventIds.size,
  });

  return { sport: SPORT, changes, deleted };
}

/**
 * Persist scores for finalized games into TeamGameResult + Game.score.
 *
 * Runs every cycle over current FINAL games; the keyed upsert and the
 * already-captured guard make it safe to re-run. A game stays FINAL for ~30h
 * while /scores covers 3 days, so there is a wide window to capture before
 * the Game document is stale-deleted.
 */
async function _captureTeamResults(scoresByEventId) {
  if (!scoresByEventId.size) return;

  const finalGames = await Game.find({ sport: SPORT, status: GAME_STATUS.FINAL })
    .select('_id oddsEventId startTime homeTeam awayTeam score')
    .lean();

  for (const g of finalGames) {
    const sc = scoresByEventId.get(String(g.oddsEventId));
    if (!sc || sc.homeScore == null || sc.awayScore == null) continue;
    // Already captured — skip the redundant write.
    if (g.score?.home != null && g.score?.away != null) continue;

    try {
      await Game.updateOne(
        { _id: g._id },
        { $set: { 'score.home': sc.homeScore, 'score.away': sc.awayScore } }
      );
      await TeamGameResult.updateOne(
        { sport: SPORT, oddsEventId: String(g.oddsEventId) },
        {
          $set: {
            sport:        SPORT,
            oddsEventId:  String(g.oddsEventId),
            startTime:    g.startTime,
            homeTeamName: g.homeTeam?.name || sc.homeTeam || null,
            awayTeamName: g.awayTeam?.name || sc.awayTeam || null,
            homeScore:    sc.homeScore,
            awayScore:    sc.awayScore,
            capturedAt:   new Date(),
          },
        },
        { upsert: true }
      );
    } catch (err) {
      logger.warn('[NFLPostGameSync] Result capture failed', {
        oddsEventId: g.oddsEventId,
        error: err.message,
      });
    }
  }
}

module.exports = { run };

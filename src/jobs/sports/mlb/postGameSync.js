/**
 * mlb.postGameSync.js — MLB-only game lifecycle + outcome grading
 *
 * Handles:
 *   SCHEDULED → LIVE (start time passed)
 *   LIVE → FINAL (3.5h+ since start)
 *   FINAL: grade unresolved insights every cycle
 *   Stale cleanup (6h+): final grade pass, void remaining, delete props+game
 *
 * TO RUN STANDALONE (test without waiting for other sports):
 *   node -e "require('./mlb.postGameSync').run().then(r => console.log(JSON.stringify(r,null,2)))"
 */

const { Game, GAME_STATUS }    = require('../../../models/Game.model');
const PlayerProp                 = require('../../../models/PlayerProp.model');
const Insight                    = require('../../../models/Insight.model');
const { gradeEvents }            = require('../../../services/queue/OutcomeDispatcherService');
const PlayerStatsSnapshotService = require('../../../services/PlayerStatsSnapshotService');
const { getAdapter }             = require('../../../services/shared/adapterRegistry');
const { cacheDel }               = require('../../../config/redis');
const logger                     = require('../../../config/logger');

const SPORT = 'mlb';
const FINALIZE_AFTER_HOURS = Number(process.env.MLB_FINALIZE_AFTER_HOURS || process.env.POST_GAME_FINALIZE_AFTER_HOURS || 3.5);
const STALE_DELETE_AFTER_HOURS = Number(process.env.MLB_STALE_DELETE_AFTER_HOURS || process.env.POST_GAME_STALE_DELETE_AFTER_HOURS || 30);
const OUTCOME_MAX_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.OUTCOME_MAX_RETRY_ATTEMPTS || '12', 10));

async function run() {
  logger.info(`🔄 [MLBPostGameSync] Starting...`);

  const now = new Date();
  const finalizeCutoff = new Date(now - FINALIZE_AFTER_HOURS * 3600000);
  const staleCutoff = new Date(now - STALE_DELETE_AFTER_HOURS * 3600000);
  const todayKey = now.toISOString().split('T')[0];
  let   changes = 0;

  // Provider scoreboard truth (The Odds API scores endpoint).
  let providerFinalEventIds = new Set();
  try {
    const adapter = getAdapter(SPORT);
    const finalIds = await adapter.fetchFinalEventIds?.({ daysFrom: 3 });
    providerFinalEventIds = new Set((finalIds || []).map(String));
  } catch (err) {
    logger.warn(`[${SPORT.toUpperCase()}PostGameSync] Provider final check unavailable`, { error: err.message });
  }

  // ── SCHEDULED → LIVE ──────────────────────────────────────────────────────
  const toLive = await Game.find({
    sport: SPORT, status: GAME_STATUS.SCHEDULED,
    startTime: { $lte: now },
  }).lean();
  if (toLive.length) {
    await Game.updateMany({ _id: { $in: toLive.map(g => g._id) } }, { $set: { status: GAME_STATUS.LIVE } });
    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    logger.info(`🏒 [${SPORT}PostGameSync] ${toLive.length} → LIVE`);
    changes += toLive.length;
  }

  // ── LIVE → FINAL ──────────────────────────────────────────────────────────
  const liveGames = await Game.find({
    sport: SPORT,
    status: GAME_STATUS.LIVE,
  }).lean();

  const toFinal = liveGames.filter(g => {
    const isTimeFinal = new Date(g.startTime) <= finalizeCutoff;
    const isProviderFinal = g.oddsEventId && providerFinalEventIds.has(String(g.oddsEventId));
    return isTimeFinal || isProviderFinal;
  });
  if (toFinal.length) {
    await Game.updateMany({ _id: { $in: toFinal.map(g => g._id) } }, { $set: { status: GAME_STATUS.FINAL } });
    await PlayerProp.updateMany({ gameId: { $in: toFinal.map(g => g._id) } }, { $set: { isAvailable: false } });

    const finalEventIds = toFinal.map(g => g.oddsEventId).filter(Boolean);
    const outcomeResult = await gradeEvents(finalEventIds, { sport: SPORT, source: 'mlb.postGameSync.finalize' });
    await PlayerStatsSnapshotService.markSportSnapshotsStale(SPORT);

    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    for (const game of toFinal) {
      for (const suffix of ['all', 'highConfidence', 'bestValue']) {
        await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
      }
    }

    logger.info(`🏁 [${SPORT}PostGameSync] ${toFinal.length} → FINAL`, { outcomes: outcomeResult });
    changes += toFinal.length;
  }

  // ── RE-GRADE FINAL games with unresolved insights (every cycle) ───────────
  const finalGames = await Game.find({ sport: SPORT, status: GAME_STATUS.FINAL })
    .select('_id oddsEventId').lean();
  if (finalGames.length) {
    const ids             = finalGames.map(g => g.oddsEventId).filter(Boolean);
    const unresolvedCount = await Insight.countDocuments({
      eventId: { $in: ids }, status: 'generated', outcomeResult: { $in: ['unresolved', null] },
    });
    if (unresolvedCount > 0) {
      const reGrade = await gradeEvents(ids, { sport: SPORT, source: 'mlb.postGameSync.regrade' });
      if (reGrade.updated > 0) {
        logger.info(`♻️  [${SPORT}PostGameSync] Re-graded ${reGrade.updated}/${unresolvedCount} unresolved`);
      }
    }
  }

  // ── DELETE STALE GAMES (6h+ past start) ───────────────────────────────────
  const stale = await Game.find({ sport: SPORT, status: GAME_STATUS.FINAL, startTime: { $lte: staleCutoff } })
    .select('_id oddsEventId').lean();
  let deleted = 0;
  if (stale.length) {
    const staleEventIds = stale.map(g => g.oddsEventId).filter(Boolean);

    await gradeEvents(staleEventIds, { sport: SPORT, source: 'mlb.postGameSync.stale' });

    const voidResult = await Insight.updateMany(
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
    if (voidResult.modifiedCount > 0) {
      logger.warn(`⚠️  [${SPORT}PostGameSync] Voided ${voidResult.modifiedCount} insights`);
    }

    const staleIds = stale.map(g => g._id);
    await PlayerProp.deleteMany({ gameId: { $in: staleIds } });
    await Game.deleteMany({ _id: { $in: staleIds } });

    await cacheDel(`schedule:${SPORT}:${todayKey}`);
    await cacheDel(`schedule:${SPORT}:${new Date(Date.now()-86400000).toISOString().split('T')[0]}`);

    deleted = stale.length;
    logger.info(`🗑️  [${SPORT}PostGameSync] Deleted ${deleted} stale games`);
  }

  logger.info(`✅ [MLBPostGameSync] Done`, {
    changes,
    deleted,
    providerFinalCount: providerFinalEventIds.size,
    config: {
      finalizeAfterHours: FINALIZE_AFTER_HOURS,
      staleDeleteAfterHours: STALE_DELETE_AFTER_HOURS,
      maxRetryAttempts: OUTCOME_MAX_RETRY_ATTEMPTS,
    },
  });
  return { sport: SPORT, changes, deleted };
}

module.exports = { run };


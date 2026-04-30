/**
 * nhl.postGameSync.js — NHL-only game lifecycle + outcome grading
 *
 * Handles:
 *   SCHEDULED → LIVE (start time passed)
 *   LIVE → FINAL (3.5h+ since start)
 *   FINAL: grade unresolved insights every cycle
 *   Stale cleanup (6h+): final grade pass, void remaining, delete props+game
 *
 * TO RUN STANDALONE (test without waiting for other sports):
 *   node -e "require('./nhl.postGameSync').run().then(r => console.log(JSON.stringify(r,null,2)))"
 */

const { Game, GAME_STATUS }    = require('../../../models/Game.model');
const PlayerProp                 = require('../../../models/PlayerProp.model');
const Insight                    = require('../../../models/Insight.model');
const InsightOutcomeService      = require('../../../services/InsightOutcomeService');
const PlayerStatsSnapshotService = require('../../../services/PlayerStatsSnapshotService');
const { cacheDel }             = require('../../../config/redis');
const logger                     = require('../../../config/logger');

const SPORT = 'nhl';

async function run() {
  logger.info(`🔄 [NHLPostGameSync] Starting...`);

  const now             = new Date();
  const threeHalfHrsAgo = new Date(now - 3.5 * 3600000);
  const sixHrsAgo       = new Date(now - 6   * 3600000);
  const todayKey        = now.toISOString().split('T')[0];
  let   changes         = 0;

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
  const toFinal = await Game.find({
    sport: SPORT, status: GAME_STATUS.LIVE,
    startTime: { $lte: threeHalfHrsAgo },
  }).lean();
  if (toFinal.length) {
    await Game.updateMany({ _id: { $in: toFinal.map(g => g._id) } }, { $set: { status: GAME_STATUS.FINAL } });
    await PlayerProp.updateMany({ gameId: { $in: toFinal.map(g => g._id) } }, { $set: { isAvailable: false } });

    const finalEventIds = toFinal.map(g => g.oddsEventId).filter(Boolean);
    const outcomeResult = await InsightOutcomeService.persistOutcomesForEvents(finalEventIds);
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
      eventId: { $in: ids }, status: 'generated', outcomeResult: 'unresolved',
    });
    if (unresolvedCount > 0) {
      const reGrade = await InsightOutcomeService.persistOutcomesForEvents(ids);
      if (reGrade.updated > 0) {
        logger.info(`♻️  [${SPORT}PostGameSync] Re-graded ${reGrade.updated}/${unresolvedCount} unresolved`);
      }
    }
  }

  // ── DELETE STALE GAMES (6h+ past start) ───────────────────────────────────
  const stale = await Game.find({ sport: SPORT, startTime: { $lte: sixHrsAgo } })
    .select('_id oddsEventId').lean();
  let deleted = 0;
  if (stale.length) {
    const staleEventIds = stale.map(g => g.oddsEventId).filter(Boolean);

    await InsightOutcomeService.persistOutcomesForEvents(staleEventIds);

    const voidResult = await Insight.updateMany(
      { eventId: { $in: staleEventIds }, outcomeResult: 'unresolved' },
      { $set: { outcomeResult: 'void', outcomeGradedAt: new Date() } }
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

  logger.info(`✅ [NHLPostGameSync] Done`, { changes, deleted });
  return { sport: SPORT, changes, deleted };
}

module.exports = { run };


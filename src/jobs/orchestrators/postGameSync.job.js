/**
 * postGameSync.job.js — Orchestrator: runs per-sport sync in PARALLEL
 *
 * Each sport's game lifecycle is completely independent.
 * Add a new sport: create sports/newSport.postGameSync.js and add to SYNCS.
 */

const cron   = require('node-cron');
const logger = require('../../config/logger');
const Insight = require('../../models/Insight.model');

const SYNCS = {
  nba: require('../sports/nba/postGameSync'),
  mlb: require('../sports/mlb/postGameSync'),
  nfl: require('../sports/nfl/postGameSync'),
  nhl: require('../sports/nhl/postGameSync'),
  soccer: require('../sports/soccer/postGameSync'),
};

const runPostGameSync = async (sport = null) => {
  logger.info('🔄 [PostGameSync] Starting lifecycle sync...');

  const targets = sport
    ? { [sport]: SYNCS[sport] }
    : SYNCS;

  // Run all sports in PARALLEL
  const results = await Promise.allSettled(
    Object.entries(targets).map(([s, sync]) =>
      sync.run().catch(err => {
        logger.error(`❌ [PostGameSync] ${s} failed`, { error: err.message });
        return { sport: s, error: err.message };
      })
    )
  );

  const summary = results.map((r, i) => ({
    sport:  Object.keys(targets)[i],
    status: r.status,
    result: r.value || r.reason,
  }));

  logger.info('✅ [PostGameSync] Lifecycle sync complete', { summary });
  return summary;
};

const runAILogCleanup = async () => {
  const result = await Insight.updateMany(
    { aiLogExpiresAt: { $lte: new Date() }, aiLog: { $ne: null } },
    { $unset: { aiLog: '' } }
  );
  logger.info(`✅ [PostGameSync] AI log cleanup — ${result.modifiedCount} cleared`);
  return { cleared: result.modifiedCount };
};

/**
 * Prune ungraded insights that have exhausted retries (player not found,
 * void_retry_exhausted, etc.). Graded insights (win/loss/push) are NOT
 * touched here — see runArchiveAndPruneGraded for that.
 */
const runExhaustedInsightPrune = async () => {
  const PerformanceService = require('../../services/PerformanceService');
  const days = Math.max(7, parseInt(process.env.RETRY_EXHAUSTED_PRUNE_DAYS || '14', 10));
  const result = await PerformanceService.pruneExhaustedRetries({ days });
  logger.info(`✅ [PostGameSync] Pruned ${result.deleted} exhausted-retry insights (>${days}d)`);
  return result;
};

/**
 * Rolling-window cleanup of GRADED insights. Aggregates lifetime totals
 * into PerformanceArchive (one tiny doc per sport) before deleting the
 * originals. Public hit-rate stays accurate because it blends archive +
 * live counts.
 */
const runArchiveAndPruneGraded = async () => {
  const PerformanceService = require('../../services/PerformanceService');
  const days = Math.max(30, parseInt(process.env.GRADED_RETENTION_DAYS || '90', 10));
  const result = await PerformanceService.archiveAndPruneGraded({ days });
  logger.info(`✅ [PostGameSync] Archived ${result.archived} graded insights, deleted ${result.deleted} (>${days}d retention)`);
  return result;
};

const registerPostGameSyncJob = () => {
  if (process.env.CRON_POST_GAME_SYNC_ENABLED !== 'true') {
    logger.info('⏭️  [PostGameSync] Disabled');
    return;
  }

  cron.schedule('*/15 * * * *', async () => {
    try { await runPostGameSync(); }
    catch (err) { logger.error('❌ [PostGameSync] Cron crashed', { error: err.message }); }
  });

  cron.schedule('0 3 * * *', async () => {
    try {
      await runAILogCleanup();
      await runExhaustedInsightPrune();
      await runArchiveAndPruneGraded();
    } catch (err) {
      logger.error('❌ [PostGameSync] Daily cleanup crashed', { error: err.message });
    }
  });

  logger.info('✅ [PostGameSync] Registered — every 15min (parallel per-sport) + 3AM cleanup (logs, retries, archive)');
};

module.exports = {
  registerPostGameSyncJob,
  runPostGameSync,
  runAILogCleanup,
  runExhaustedInsightPrune,
  runArchiveAndPruneGraded,
};


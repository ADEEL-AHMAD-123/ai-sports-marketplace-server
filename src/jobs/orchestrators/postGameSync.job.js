/**
 * postGameSync.job.js — Orchestrator: runs per-sport sync in PARALLEL
 *
 * Each sport's game lifecycle is completely independent.
 * Add a new sport: create sports/newSport.postGameSync.js and add to SYNCS.
 */

const cron   = require('node-cron');
const logger = require('../../config/logger');
const Insight = require('../../models/Insight.model');
const { Game, GAME_STATUS } = require('../../models/Game.model');

const SYNCS = {
  nba: require('../sports/nba/postGameSync'),
  mlb: require('../sports/mlb/postGameSync'),
  nfl: require('../sports/nfl/postGameSync'),
  nhl: require('../sports/nhl/postGameSync'),
  soccer: require('../sports/soccer/postGameSync'),
};

const POST_GAME_SYNC_SCHEDULE = process.env.CRON_POST_GAME_SYNC_SCHEDULE || '*/20 * * * *';
const POST_GAME_CLEANUP_SCHEDULE = process.env.CRON_POST_GAME_CLEANUP_SCHEDULE || '0 3 * * *';
const POST_GAME_SYNC_IDLE_MIN_INTERVAL_MINUTES = Math.max(
  20,
  parseInt(process.env.POST_GAME_SYNC_IDLE_MIN_INTERVAL_MINUTES || '60', 10)
);
const POST_GAME_ACTIVE_LOOKAHEAD_HOURS = Math.max(
  1,
  parseInt(process.env.POST_GAME_ACTIVE_LOOKAHEAD_HOURS || '3', 10)
);
let postGameSyncRunning = false;
let postGameCleanupRunning = false;
let lastPostGameSyncAt = null;

const minutesSince = (date, now = new Date()) => {
  if (!date) return Infinity;
  return (now.getTime() - date.getTime()) / 60000;
};

/**
 * Decide which sports have outstanding lifecycle work this cycle.
 *
 * A sport is "active" when it has at least one game in any of these states:
 *   • LIVE       — needs the LIVE→FINAL transition and outcome grading.
 *   • SCHEDULED with startTime ≤ lookahead — needs the SCHEDULED→LIVE
 *     transition. There is deliberately NO lower bound on startTime: a game
 *     whose start time has already passed must still be flipped to LIVE, and
 *     bounding the lower edge to `now` let past-due scheduled games slip
 *     through when the sport had nothing else active.
 *   • FINAL      — still needs outcome re-grading and, eventually, stale
 *     cleanup. There is deliberately NO age bound here either: grade retries
 *     run for hours and each sport's stale-delete only fires at ~30h, so a
 *     short recency window left FINAL games stranded in a 12–30h limbo where
 *     they were neither re-graded nor cleaned up. Every FINAL game must be
 *     revisited until its own postGameSync deletes it.
 */
const getActivePostGameSports = async (now = new Date()) => {
  const lookahead = new Date(now.getTime() + POST_GAME_ACTIVE_LOOKAHEAD_HOURS * 3600000);

  const rows = await Game.aggregate([
    {
      $match: {
        $or: [
          { status: GAME_STATUS.LIVE },
          { status: GAME_STATUS.SCHEDULED, startTime: { $lte: lookahead } },
          { status: GAME_STATUS.FINAL },
        ],
      },
    },
    { $group: { _id: '$sport' } },
  ]);

  return rows.map((r) => r._id).filter((s) => !!s && !!SYNCS[s]);
};

const runPostGameSync = async (sport = null, activeSportsOverride = null) => {
  logger.info('🔄 [PostGameSync] Starting lifecycle sync...');

  let targets;
  if (sport) {
    targets = { [sport]: SYNCS[sport] };
  } else {
    const activeSports = Array.isArray(activeSportsOverride)
      ? activeSportsOverride
      : await getActivePostGameSports();
    targets = Object.fromEntries(activeSports.map((s) => [s, SYNCS[s]]));
  }

  if (!Object.keys(targets).length) {
    logger.info('⏭️  [PostGameSync] No active sports — skipping lifecycle sync');
    return [];
  }

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

const runPostGameSyncWithLock = async () => {
  if (postGameSyncRunning) {
    logger.warn('⏭️  [PostGameSync] Previous lifecycle run still active, skipping overlap trigger');
    return { skipped: true };
  }

  const now = new Date();
  const activeSports = await getActivePostGameSports(now);
  const hasActiveSports = activeSports.length > 0;
  const idleElapsedMin = minutesSince(lastPostGameSyncAt, now);
  if (!hasActiveSports && idleElapsedMin < POST_GAME_SYNC_IDLE_MIN_INTERVAL_MINUTES) {
    logger.info('⏭️  [PostGameSync] Idle throttle skip', {
      idleElapsedMin: Math.round(idleElapsedMin),
      idleMinInterval: POST_GAME_SYNC_IDLE_MIN_INTERVAL_MINUTES,
    });
    return { skipped: true, idleThrottled: true };
  }

  postGameSyncRunning = true;
  const startedAt = Date.now();
  try {
    const result = await runPostGameSync(null, activeSports);
    lastPostGameSyncAt = new Date();
    return result;
  } finally {
    postGameSyncRunning = false;
    logger.debug('🔓 [PostGameSync] Lifecycle lock released', { durationMs: Date.now() - startedAt });
  }
};

const runDailyCleanupWithLock = async () => {
  if (postGameCleanupRunning) {
    logger.warn('⏭️  [PostGameSync] Previous cleanup run still active, skipping overlap trigger');
    return { skipped: true };
  }

  postGameCleanupRunning = true;
  const startedAt = Date.now();
  try {
    await runAILogCleanup();
    await runExhaustedInsightPrune();
    await runArchiveAndPruneGraded();
    return { skipped: false };
  } finally {
    postGameCleanupRunning = false;
    logger.debug('🔓 [PostGameSync] Cleanup lock released', { durationMs: Date.now() - startedAt });
  }
};

const registerPostGameSyncJob = () => {
  if (process.env.CRON_POST_GAME_SYNC_ENABLED !== 'true') {
    logger.info('⏭️  [PostGameSync] Disabled');
    return;
  }

  cron.schedule(POST_GAME_SYNC_SCHEDULE, async () => {
    try { await runPostGameSyncWithLock(); }
    catch (err) { logger.error('❌ [PostGameSync] Cron crashed', { error: err.message }); }
  });

  cron.schedule(POST_GAME_CLEANUP_SCHEDULE, async () => {
    try {
      await runDailyCleanupWithLock();
    } catch (err) {
      logger.error('❌ [PostGameSync] Daily cleanup crashed', { error: err.message });
    }
  });

  logger.info('✅ [PostGameSync] Registered — staggered lifecycle + daily cleanup', {
    lifecycleSchedule: POST_GAME_SYNC_SCHEDULE,
    cleanupSchedule: POST_GAME_CLEANUP_SCHEDULE,
  });
};

module.exports = {
  registerPostGameSyncJob,
  runPostGameSync,
  runAILogCleanup,
  runExhaustedInsightPrune,
  runArchiveAndPruneGraded,
};


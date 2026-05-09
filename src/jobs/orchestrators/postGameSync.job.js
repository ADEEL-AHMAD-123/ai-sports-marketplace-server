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
    try { await runAILogCleanup(); }
    catch (err) { logger.error('❌ [PostGameSync] AI cleanup crashed', { error: err.message }); }
  });

  logger.info('✅ [PostGameSync] Registered — every 15min (parallel per-sport) + 3AM cleanup');
};

module.exports = { registerPostGameSyncJob, runPostGameSync, runAILogCleanup };


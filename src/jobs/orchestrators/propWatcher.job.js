/**
 * propWatcher.job.js — Orchestrator: runs per-sport watchers in PARALLEL
 *
 * Each sport runs independently — an NBA API timeout does NOT block MLB.
 * The per-sport files handle all sport-specific logic.
 * Add a new sport: create sports/newSport.propWatcher.js and add to WATCHERS.
 */

const cron   = require('node-cron');
const logger = require('../../config/logger');

const WATCHERS = {
  nba: require('../sports/nba/propWatcher'),
  mlb: require('../sports/mlb/propWatcher'),
  nhl: require('../sports/nhl/propWatcher'),
};

const runPropWatcher = async (sport = null) => {
  logger.info('👁️  [PropWatcher] Starting cycle...');

  const targets = sport
    ? { [sport]: WATCHERS[sport] }
    : WATCHERS;

  // Run all sports in PARALLEL — not sequential
  const results = await Promise.allSettled(
    Object.entries(targets).map(([s, watcher]) =>
      watcher.run().catch(err => {
        logger.error(`❌ [PropWatcher] ${s} failed`, { error: err.message });
        return { sport: s, error: err.message };
      })
    )
  );

  const summary = results.map((r, i) => ({
    sport:  Object.keys(targets)[i],
    status: r.status,
    result: r.value || r.reason,
  }));

  logger.info('✅ [PropWatcher] Cycle complete', { summary });
  return summary;
};

const registerPropWatcherJob = () => {
  if (process.env.CRON_PROP_WATCHER_ENABLED !== 'true') {
    logger.info('⏭️  [PropWatcher] Disabled');
    return;
  }
  cron.schedule('*/30 * * * *', async () => {
    try { await runPropWatcher(); }
    catch (err) { logger.error('❌ [PropWatcher] Cron crashed', { error: err.message }); }
  });
  logger.info('✅ [PropWatcher] Registered — every 30 minutes (parallel per-sport)');
};

module.exports = { registerPropWatcherJob, runPropWatcher };


/**
 * propWatcher.job.js — Orchestrator: runs per-sport watchers in PARALLEL
 *
 * Each sport runs independently — an NBA API timeout does NOT block MLB.
 * The per-sport files handle all sport-specific logic.
 * Add a new sport: create sports/newSport.propWatcher.js and add to WATCHERS.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const cron   = require('node-cron');
const logger = require('../../config/logger');

const WATCHERS = {
  nba: require('../sports/nba/propWatcher'),
  mlb: require('../sports/mlb/propWatcher'),
  nfl: require('../sports/nfl/propWatcher'),
  nhl: require('../sports/nhl/propWatcher'),
  soccer: require('../sports/soccer/propWatcher'),
};

const PROP_WATCHER_SCHEDULE = process.env.CRON_PROP_WATCHER_SCHEDULE || '2,32 * * * *';
let propWatcherRunning = false;

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

const runPropWatcherWithLock = async () => {
  if (propWatcherRunning) {
    logger.warn('⏭️  [PropWatcher] Previous cycle still running, skipping overlap trigger');
    return { skipped: true };
  }

  propWatcherRunning = true;
  const startedAt = Date.now();
  try {
    return await runPropWatcher();
  } finally {
    propWatcherRunning = false;
    logger.debug('🔓 [PropWatcher] Cycle lock released', { durationMs: Date.now() - startedAt });
  }
};

const registerPropWatcherJob = () => {
  if (process.env.CRON_PROP_WATCHER_ENABLED !== 'true') {
    logger.info('⏭️  [PropWatcher] Disabled');
    return;
  }
  cron.schedule(PROP_WATCHER_SCHEDULE, async () => {
    try { await runPropWatcherWithLock(); }
    catch (err) { logger.error('❌ [PropWatcher] Cron crashed', { error: err.message }); }
  });
  logger.info('✅ [PropWatcher] Registered — staggered schedule (parallel per-sport)', {
    schedule: PROP_WATCHER_SCHEDULE,
  });
};

module.exports = { registerPropWatcherJob, runPropWatcher };

if (require.main === module) {
  const connectDB = require('../../config/database');
  connectDB()
    .then(() => runPropWatcher())
    .then(summary => { logger.info('Done', { summary }); process.exit(0); })
    .catch(err   => { logger.error('Fatal', { error: err.message }); process.exit(1); });
}


/**
 * postGameSync.job.js
 *
 * Runs every 15 minutes and handles the full game lifecycle:
 *
 * 1. SCHEDULED → LIVE:   Mark games whose startTime has passed as LIVE
 * 2. LIVE → FINAL:       Mark games that started 3.5h+ ago as FINAL
 *                         (NBA avg game = 2h20m, buffer = 1h10m)
 * 3. FINAL → DELETED:    Delete games + props that are 6h+ past start time
 * 4. Redis cache clear:  Invalidate schedule cache after any status change
 *
 * This keeps MongoDB lean and the frontend always accurate.
 */

const cron   = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const { cacheDel } = require('../config/redis');
const logger = require('../config/logger');

// ── Main sync ─────────────────────────────────────────────────
const runPostGameSync = async () => {
  logger.info('🔄 [PostGameSync] Starting lifecycle sync...');

  const activeSports = ['nba', 'nfl', 'mlb', 'nhl', 'soccer'];
  let totalChanges = 0;

  for (const sport of activeSports) {
    const changes = await _syncGameLifecycle(sport);
    totalChanges += changes;
  }

  // Always run cleanup regardless of sport
  const deleted = await _deleteStaleData();

  logger.info(`✅ [PostGameSync] Done — ${totalChanges} status changes, ${deleted} games deleted`);
};

// ── Step 1 & 2: Handle SCHEDULED → LIVE → FINAL transitions ──
const _syncGameLifecycle = async (sport) => {
  const now              = new Date();
  const threeHalfHoursAgo = new Date(now.getTime() - 3.5 * 60 * 60 * 1000);
  let changes = 0;

  // ── SCHEDULED → LIVE: games whose start time has passed ──────
  const toMarkLive = await Game.find({
    sport,
    status:    GAME_STATUS.SCHEDULED,
    startTime: { $lte: now },
  }).lean();

  if (toMarkLive.length > 0) {
    await Game.updateMany(
      { _id: { $in: toMarkLive.map(g => g._id) } },
      { $set: { status: GAME_STATUS.LIVE } }
    );

    // Clear Redis so frontend immediately sees LIVE badge
    const todayKey = new Date().toISOString().split('T')[0];
    await cacheDel(`schedule:${sport}:${todayKey}`);

    logger.info(`🏀 [PostGameSync] Marked ${toMarkLive.length} games as LIVE for ${sport}`);
    changes += toMarkLive.length;
  }

  // ── LIVE → FINAL: games that started 3.5h+ ago ───────────────
  const toMarkFinal = await Game.find({
    sport,
    status:    GAME_STATUS.LIVE,
    startTime: { $lte: threeHalfHoursAgo },
  }).lean();

  if (toMarkFinal.length > 0) {
    await Game.updateMany(
      { _id: { $in: toMarkFinal.map(g => g._id) } },
      { $set: { status: GAME_STATUS.FINAL } }
    );

    // Mark props as unavailable — market is closed
    const gameIds = toMarkFinal.map(g => g._id);
    await PlayerProp.updateMany(
      { gameId: { $in: gameIds } },
      { $set: { isAvailable: false } }
    );

    // Clear Redis for each finalized game
    const todayKey = new Date().toISOString().split('T')[0];
    await cacheDel(`schedule:${sport}:${todayKey}`);
    for (const game of toMarkFinal) {
      await cacheDel(`props:${sport}:${game.oddsEventId}:all`);
      await cacheDel(`props:${sport}:${game.oddsEventId}:highConfidence`);
      await cacheDel(`props:${sport}:${game.oddsEventId}:bestValue`);
    }

    logger.info(`🏁 [PostGameSync] Marked ${toMarkFinal.length} games as FINAL for ${sport}`, {
      games: toMarkFinal.map(g => `${g.homeTeam?.name} vs ${g.awayTeam?.name}`),
    });
    changes += toMarkFinal.length;
  }

  return changes;
};

// ── Step 3: Delete games 6h+ past start time ─────────────────
const _deleteStaleData = async () => {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const staleGames = await Game.find({
    startTime: { $lte: sixHoursAgo },
  }).select('_id oddsEventId sport').lean();

  if (staleGames.length === 0) return 0;

  const ids      = staleGames.map(g => g._id);
  const eventIds = staleGames.map(g => g.oddsEventId);
  const sports   = [...new Set(staleGames.map(g => g.sport))];

  // Delete props first (foreign key order)
  await PlayerProp.deleteMany({ gameId: { $in: ids } });

  // Delete games
  await Game.deleteMany({ _id: { $in: ids } });

  // Clear schedule cache for all affected sports
  const todayKey = new Date().toISOString().split('T')[0];
  for (const sport of sports) {
    await cacheDel(`schedule:${sport}:${todayKey}`);
    // Also clear yesterday's key in case of timezone boundary
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await cacheDel(`schedule:${sport}:${yesterday}`);
  }

  logger.info(`🗑️  [PostGameSync] Deleted ${staleGames.length} stale games and their props`);
  return staleGames.length;
};

// ── AI log cleanup (runs daily at 3 AM) ──────────────────────
const runAILogCleanup = async () => {
  const Insight = require('../models/Insight.model');
  const result = await Insight.updateMany(
    { aiLogExpiresAt: { $lte: new Date() }, aiLog: { $ne: null } },
    { $unset: { aiLog: '' } }
  );
  logger.info(`✅ [PostGameSync] AI log cleanup — ${result.modifiedCount} cleared`);
};

// ── Register cron ─────────────────────────────────────────────
const registerPostGameSyncJob = () => {
  if (process.env.CRON_POST_GAME_SYNC_ENABLED !== 'true') {
    logger.info('⏭️  [PostGameSync] Disabled (CRON_POST_GAME_SYNC_ENABLED not set)');
    return;
  }

  // Every 15 minutes — keeps game statuses accurate
  cron.schedule('*/15 * * * *', async () => {
    try { await runPostGameSync(); }
    catch (err) { logger.error('❌ [PostGameSync] Cron crashed', { error: err.message }); }
  });

  // Daily at 3 AM — AI log cleanup
  cron.schedule('0 3 * * *', async () => {
    try { await runAILogCleanup(); }
    catch (err) { logger.error('❌ [PostGameSync] AI cleanup crashed', { error: err.message }); }
  });

  logger.info('✅ [PostGameSync] Registered — every 15min lifecycle sync + 3AM cleanup');
};

module.exports = { registerPostGameSyncJob, runPostGameSync, runAILogCleanup };
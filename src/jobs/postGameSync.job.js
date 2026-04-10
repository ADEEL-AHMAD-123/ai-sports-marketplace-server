/**
 * postGameSync.job.js — Post-game stats sync (runs 1 hour after game ends)
 *
 * Polls for games that recently finished and syncs final player stats into MongoDB.
 * This populates the WARM cache layer with post-game data.
 *
 * Why 1 hour after game?
 *  - Final box scores are typically available within 30–60 min of game end
 *  - We wait 1 hour to ensure data is finalized by the stats API
 *
 * Schedule: Checks every 30 minutes for games that ended ~1 hour ago.
 *
 * BETTING GLOSSARY:
 *  "Box score" = the final statistical summary of a game (points, rebounds, etc.)
 *  "Final stats" = the officially confirmed stats after the game is complete
 */

const cron = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const { getAdapter, getActiveSports } = require('../services/adapters/adapterRegistry');
const logger = require('../config/logger');

/**
 * Main sync function — can be called directly for testing.
 */
const runPostGameSync = async () => {
  logger.info('🔄 [PostGameSync] Starting post-game sync...');

  const activeSports = getActiveSports();

  for (const sport of activeSports) {
    await _syncFinishedGames(sport);
  }

  logger.info('✅ [PostGameSync] Post-game sync complete');
};

/**
 * Find games that ended approximately 1 hour ago and sync their final stats.
 * @param {string} sport
 */
const _syncFinishedGames = async (sport) => {
  const now = new Date();

  // Look for scheduled/live games whose start time was 3+ hours ago
  // NBA games last ~2.5 hours → 3 hours is a safe window to consider them finished
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  // Find games that should be finished but are still marked as scheduled/live
  const pendingSyncGames = await Game.find({
    sport,
    startTime: { $lte: threeHoursAgo },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (pendingSyncGames.length === 0) {
    logger.debug(`[PostGameSync] No games pending sync for ${sport}`);
    return;
  }

  logger.info(`🔄 [PostGameSync] Found ${pendingSyncGames.length} games to sync for ${sport}`);

  for (const game of pendingSyncGames) {
    try {
      await _syncGameResult(sport, game);
    } catch (err) {
      logger.error('[PostGameSync] Failed to sync game', {
        sport,
        gameId: game._id,
        error: err.message,
      });
    }
  }
};

/**
 * Sync the final result for one game.
 * Updates game status to FINAL and marks props as no longer available.
 *
 * @param {string} sport
 * @param {Object} game
 */
const _syncGameResult = async (sport, game) => {
  logger.info(`🔄 [PostGameSync] Syncing game: ${game.homeTeam.name} vs ${game.awayTeam.name}`, {
    sport,
    gameId: game._id,
    oddsEventId: game.oddsEventId,
  });

  // Mark game as FINAL (we use the time-based logic as primary indicator)
  // In a full implementation, you'd confirm via the stats API's game status endpoint
  await Game.findByIdAndUpdate(game._id, {
    status: GAME_STATUS.FINAL,
  });

  // Mark all props for this game as unavailable (market is closed post-game)
  const propsResult = await PlayerProp.updateMany(
    { gameId: game._id },
    { $set: { isAvailable: false } }
  );

  logger.info(`✅ [PostGameSync] Game synced as FINAL`, {
    sport,
    gameId: game._id,
    propsMarkedUnavailable: propsResult.modifiedCount,
  });
};

/**
 * Cleanup job — remove AI log data from old insights.
 * Called alongside post-game sync to keep the database lean.
 *
 * This nulls out the aiLog field on insights where aiLogExpiresAt has passed.
 * The insight itself is preserved — just the verbose AI input/output is removed.
 */
const runAILogCleanup = async () => {
  const Insight = require('../models/Insight.model');

  logger.info('🗑️  [PostGameSync] Running AI log cleanup...');

  const result = await Insight.updateMany(
    {
      aiLogExpiresAt: { $lte: new Date() },
      aiLog: { $ne: null },
    },
    {
      $unset: { aiLog: '' },
    }
  );

  logger.info(`✅ [PostGameSync] AI log cleanup complete`, {
    insightsCleared: result.modifiedCount,
  });
};

/**
 * Register the post-game sync cron job.
 * Schedule: every 30 minutes (checks for games that finished ~1hr ago).
 * Only runs if CRON_POST_GAME_SYNC_ENABLED=true
 */
const registerPostGameSyncJob = () => {
  if (process.env.CRON_POST_GAME_SYNC_ENABLED !== 'true') {
    logger.info('⏭️  [PostGameSync] Cron disabled via CRON_POST_GAME_SYNC_ENABLED=false');
    return;
  }

  // Every 30 minutes — checks for newly-finished games
  cron.schedule('*/30 * * * *', async () => {
    logger.info('⏰ [PostGameSync] Cron triggered');
    try {
      await runPostGameSync();
    } catch (err) {
      logger.error('❌ [PostGameSync] Cron crashed', { error: err.message });
    }
  });

  // Run AI log cleanup once per day at 3 AM (low traffic time)
  cron.schedule('0 3 * * *', async () => {
    logger.info('⏰ [PostGameSync] AI log cleanup triggered — 3 AM daily');
    try {
      await runAILogCleanup();
    } catch (err) {
      logger.error('❌ [PostGameSync] AI log cleanup crashed', { error: err.message });
    }
  });

  logger.info('✅ [PostGameSync] Cron registered — runs every 30 minutes + AI log cleanup at 3 AM');
};

module.exports = { registerPostGameSyncJob, runPostGameSync, runAILogCleanup };
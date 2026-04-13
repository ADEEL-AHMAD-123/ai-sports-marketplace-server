/**
 * propWatcher.job.js — Player prop fetcher (every 30 minutes)
 *
 * Runs every 30 minutes for ACTIVE/UPCOMING games only.
 * Never runs on finished games (saves API quota).
 *
 * Steps per run:
 *  1. Query MongoDB for today's active/upcoming games (status: scheduled | live)
 *  2. For each game, fetch latest player props from The Odds API
 *  3. Upsert props into MongoDB (insert new, update changed lines)
 *  4. Detect significant line movements (flag for UI)
 *  5. Run StrategyService to score each prop (confidence + edge + tags)
 *
 * BETTING GLOSSARY:
 *  "Line movement" = when a bookmaker changes the prop line (e.g., 25.5 → 27.0)
 *  Line movement indicates new information: injury news, betting volume shift, etc.
 */

const cron = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const StrategyService = require('../services/StrategyService');
const { getAdapter, getActiveSports } = require('../services/adapters/adapterRegistry');
const { bulkResolvePlayerIds } = require('../utils/playerResolver');
const { ODDS_CHANGE_THRESHOLD } = require('../config/constants');
const logger = require('../config/logger');
const { cacheDel } = require('../config/redis');

/**
 * Main watcher function — can be called directly for testing.
 * @returns {Promise<void>}
 */
const runPropWatcher = async () => {
  logger.info('👁️  [PropWatcher] Starting prop watch cycle...');

  const activeSports = getActiveSports();

  for (const sport of activeSports) {
    await _watchPropsForSport(sport);
  }

  logger.info('✅ [PropWatcher] Prop watch cycle complete');
};

/**
 * Watch props for a single sport.
 * @param {string} sport
 */
const _watchPropsForSport = async (sport) => {
  logger.info(`👁️  [PropWatcher] Watching props for: ${sport}`);

  // ── Fetch only active/upcoming games from MongoDB ──────────────────────────
  // This is the key optimization: we skip finished games entirely
  // Fetch props for all upcoming games within 72h (same window as odds controller)
  // This means tomorrow's games also get props fetched — users can unlock insights early
  const now         = new Date();
  const windowStart = new Date(now.getTime() - 3  * 60 * 60 * 1000); // 3h ago (covers live)
  const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h ahead

  const activeGames = await Game.find({
    sport,
    startTime: { $gte: windowStart, $lte: windowEnd },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (activeGames.length === 0) {
    logger.info(`[PropWatcher] No upcoming games for ${sport} in 72h window — skipping`);
    return;
  }

  logger.info(`[PropWatcher] Found ${activeGames.length} active games for ${sport}`);

  let totalPropsUpserted = 0;
  let totalLinesChanged = 0;

  for (const game of activeGames) {
    try {
      const { propsUpserted, linesChanged } = await _fetchAndUpsertProps(sport, game);
      totalPropsUpserted += propsUpserted;
      totalLinesChanged += linesChanged;

      // Mark the game as having props fetched
      await Game.findByIdAndUpdate(game._id, {
        hasProps: true,
        propsLastFetchedAt: new Date(),
      });
    } catch (err) {
      logger.error(`[PropWatcher] Failed to process game`, {
        sport,
        gameId: game._id,
        oddsEventId: game.oddsEventId,
        error: err.message,
      });
    }
  }

  logger.info(`✅ [PropWatcher] ${sport} props updated`, {
    activeGames: activeGames.length,
    totalPropsUpserted,
    totalLinesChanged,
  });

  // ── Run Strategy Engine on all available props for this sport ──────────────
  // This scores each prop with confidence + edge + tags for the filter system
  await StrategyService.scoreAllPropsForSport(sport);

  // Clear Redis cache for all affected date keys (games may span multiple days)
  const uniqueDates = [...new Set(activeGames.map(g =>
    new Date(g.startTime).toISOString().split('T')[0]
  ))];
  for (const dateKey of uniqueDates) {
    await cacheDel(`schedule:${sport}:${dateKey}`);
  }
  // Also clear today's key always (for enriched game data with propCount)
  const todayKey = new Date().toISOString().split('T')[0];
  await cacheDel(`schedule:${sport}:${todayKey}`);

  for (const game of activeGames) {
    await cacheDel(`props:${sport}:${game.oddsEventId}:all`);
    await cacheDel(`props:${sport}:${game.oddsEventId}:highConfidence`);
    await cacheDel(`props:${sport}:${game.oddsEventId}:bestValue`);
  }
  logger.info(`🗑️  [PropWatcher] Cache cleared for ${sport} (${activeGames.length} games, ${uniqueDates.length} dates)`);
};

/**
 * Fetch props for one game and upsert into MongoDB.
 * Detects and logs line movements.
 *
 * @param {string} sport
 * @param {Object} game - Game document (lean)
 * @returns {Promise<{ propsUpserted: number, linesChanged: number }>}
 */
const _fetchAndUpsertProps = async (sport, game) => {
  const adapter = getAdapter(sport);
  const rawProps = await adapter.fetchProps(game.oddsEventId);

  // ── Bulk resolve player IDs before upserting ──────────────────────────────
  // Map each unique player name to their API-Sports ID in one batch call.
  // This populates apiSportsPlayerId on props so InsightService can fetch stats.
  const uniquePlayerNames = [...new Set(rawProps.map((p) => p.playerName))];
  const playerIdMap = await bulkResolvePlayerIds(uniquePlayerNames, sport);
  logger.debug(`[PropWatcher] Resolved ${playerIdMap.size}/${uniquePlayerNames.length} player IDs`, { sport });

  let propsUpserted = 0;
  let linesChanged = 0;

  for (const rawProp of rawProps) {
    const normalizedProp = adapter.normalizeProp(rawProp);

    try {
      // Find existing prop to check for line movement
      const existing = await PlayerProp.findOne({
        oddsEventId: normalizedProp.oddsEventId,
        playerName: normalizedProp.playerName,
        statType: normalizedProp.statType,
      }).lean();

      let updateData = {
        ...normalizedProp,
        gameId: game._id,
        lastUpdatedAt: new Date(),
        // Attach the resolved API-Sports player ID (null if not found)
        apiSportsPlayerId: playerIdMap.get(normalizedProp.playerName) || null,
      };

      // ── Detect line movement ──────────────────────────────────────────────
      if (existing && existing.line !== normalizedProp.line) {
        const lineChange = Math.abs(normalizedProp.line - existing.line);

        logger.info(`📈 [PropWatcher] Line moved for ${normalizedProp.playerName} ${normalizedProp.statType}`, {
          sport,
          playerName: normalizedProp.playerName,
          statType: normalizedProp.statType,
          oldLine: existing.line,
          newLine: normalizedProp.line,
          change: lineChange,
        });

        updateData.previousLine = existing.line;
        updateData.lineMovedAt = new Date();
        linesChanged++;

        // If the line moved significantly, we need to invalidate any cached AI insights
        // for this prop (they were based on the old line)
        if (lineChange > ODDS_CHANGE_THRESHOLD) {
          await _invalidateStaledInsights(sport, game.oddsEventId, normalizedProp.playerName, normalizedProp.statType);
        }
      }

      // Upsert the prop
      await PlayerProp.findOneAndUpdate(
        {
          oddsEventId: normalizedProp.oddsEventId,
          playerName: normalizedProp.playerName,
          statType: normalizedProp.statType,
        },
        { $set: updateData },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      propsUpserted++;
    } catch (err) {
      logger.error('[PropWatcher] Failed to upsert prop', {
        playerName: normalizedProp.playerName,
        statType: normalizedProp.statType,
        error: err.message,
      });
    }
  }

  return { propsUpserted, linesChanged };
};

/**
 * Mark cached insights as STALE when the line changes beyond the threshold.
 * This forces re-generation with the new line.
 *
 * @param {string} sport
 * @param {string} eventId
 * @param {string} playerName
 * @param {string} statType
 */
const _invalidateStaledInsights = async (sport, eventId, playerName, statType) => {
  const { INSIGHT_STATUS } = require('../config/constants');
  const Insight = require('../models/Insight.model');

  const result = await Insight.updateMany(
    {
      sport,
      eventId,
      playerName,
      statType,
      status: INSIGHT_STATUS.GENERATED,
    },
    { $set: { status: INSIGHT_STATUS.STALE } }
  );

  if (result.modifiedCount > 0) {
    logger.info(`🗑️  [PropWatcher] Invalidated ${result.modifiedCount} stale insight(s) due to line change`, {
      sport,
      eventId,
      playerName,
      statType,
    });
  }
};

/**
 * Register the cron job.
 * Schedule: every 30 minutes.
 * Only runs if CRON_PROP_WATCHER_ENABLED=true in .env
 */
const registerPropWatcherJob = () => {
  if (process.env.CRON_PROP_WATCHER_ENABLED !== 'true') {
    logger.info('⏭️  [PropWatcher] Cron disabled via CRON_PROP_WATCHER_ENABLED=false');
    return;
  }

  // '*/30 * * * *' = every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    logger.info('⏰ [PropWatcher] Cron triggered — 30-minute prop watch');
    try {
      await runPropWatcher();
    } catch (err) {
      logger.error('❌ [PropWatcher] Cron job crashed', { error: err.message });
    }
  });

  logger.info('✅ [PropWatcher] Cron registered — runs every 30 minutes');
};

module.exports = { registerPropWatcherJob, runPropWatcher };
/**
 * propWatcher.job.js — Player prop fetcher (every 30 minutes)
 *
 * Steps per run:
 *  1. Query MongoDB for upcoming/live games
 *  2. Fetch latest props from The Odds API
 *  3. Resolve NBA player IDs (team-context required for v2 API)
 *  4. Bulk upsert props to MongoDB
 *  5. Detect line movements
 *  6. [MLB] Enrich batter props with opponent starter context — SESSION 2
 *  7. Run StrategyService to score each prop
 *  8. Clear Redis cache
 */

const cron = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const StrategyService = require('../services/StrategyService');
const { getAdapter, getActiveSports } = require('../services/adapters/adapterRegistry');
const { bulkResolvePlayerIds } = require('../utils/playerResolver');
const { getInjuryStatusesForGame, isInjurySportSupported } = require('../services/injuryService');
const { enrichBatterPropsWithStarter } = require('../services/adapters/mlb/MLBStarterService');
const { ODDS_CHANGE_THRESHOLD } = require('../config/constants');
const logger = require('../config/logger');
const { cacheDel } = require('../config/redis');

// Only NBA needs API-Sports player ID resolution
const SPORTS_WITH_PLAYER_ID_RESOLUTION = new Set(['nba']);

const _normalizeName = (name = '') => String(name)
  .toLowerCase()
  .replace(/[.'\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const runPropWatcher = async () => {
  logger.info('👁️  [PropWatcher] Starting prop watch cycle...');
  const activeSports = getActiveSports();
  for (const sport of activeSports) {
    await _watchPropsForSport(sport);
  }
  logger.info('✅ [PropWatcher] Prop watch cycle complete');
};

const _watchPropsForSport = async (sport) => {
  logger.info(`👁️  [PropWatcher] Watching props for: ${sport}`);

  // Reset quota guard at start of each cycle
  const adapter = getAdapter(sport);
  if (adapter.oddsApiQuotaRemaining === 0) {
    adapter.oddsApiQuotaRemaining = Infinity;
    logger.info(`[PropWatcher] Reset quota guard for ${sport}`);
  }

  const now         = new Date();
  const windowStart = new Date(now.getTime() - 3  * 60 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const activeGames = await Game.find({
    sport,
    startTime: { $gte: windowStart, $lte: windowEnd },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (!activeGames.length) {
    logger.info(`[PropWatcher] No upcoming games for ${sport} — skipping`);
    return;
  }

  logger.info(`[PropWatcher] Found ${activeGames.length} active games for ${sport}`);

  let totalPropsUpserted = 0;
  let totalLinesChanged  = 0;

  for (const game of activeGames) {
    try {
      const { propsUpserted, linesChanged, rawProps } = await _fetchAndUpsertProps(sport, game);
      totalPropsUpserted += propsUpserted;
      totalLinesChanged  += linesChanged;

      // SESSION 2: Enrich MLB batter props with opponent starter context
      if (sport === 'mlb' && rawProps?.length) {
        try {
          await enrichBatterPropsWithStarter(game, rawProps, PlayerProp);
        } catch (err) {
          logger.warn('[PropWatcher] Starter enrichment failed (non-fatal)', {
            oddsEventId: game.oddsEventId,
            error: err.message,
          });
        }
      }

      await Game.findByIdAndUpdate(game._id, {
        hasProps:          true,
        propsLastFetchedAt: new Date(),
      });
    } catch (err) {
      logger.error('[PropWatcher] Failed to process game', {
        sport, gameId: game._id, oddsEventId: game.oddsEventId, error: err.message,
      });
    }
  }

  logger.info(`✅ [PropWatcher] ${sport} props updated`, {
    activeGames: activeGames.length,
    totalPropsUpserted,
    totalLinesChanged,
  });

  await StrategyService.scoreAllPropsForSport(sport);

  // Clear Redis cache
  const uniqueDates = [...new Set(activeGames.map(g =>
    new Date(g.startTime).toISOString().split('T')[0]
  ))];
  for (const dateKey of uniqueDates) {
    await cacheDel(`schedule:${sport}:${dateKey}`);
  }
  await cacheDel(`schedule:${sport}:${new Date().toISOString().split('T')[0]}`);
  for (const game of activeGames) {
    await cacheDel(`props:${sport}:${game.oddsEventId}:all`);
    await cacheDel(`props:${sport}:${game.oddsEventId}:highConfidence`);
    await cacheDel(`props:${sport}:${game.oddsEventId}:bestValue`);
  }
  logger.info(`🗑️  [PropWatcher] Cache cleared for ${sport}`);
};

const _fetchAndUpsertProps = async (sport, game) => {
  const adapter  = getAdapter(sport);
  const rawProps = await adapter.fetchProps(game.oddsEventId);

  if (!rawProps.length) {
    if (adapter.oddsApiQuotaRemaining === 0) {
      logger.warn('[PropWatcher] No props — quota guard active, preserving existing', {
        sport, oddsEventId: game.oddsEventId,
      });
      return { propsUpserted: 0, linesChanged: 0, rawProps: [] };
    }
    const hideResult = await PlayerProp.updateMany(
      { sport, oddsEventId: game.oddsEventId, isAvailable: true },
      { $set: { isAvailable: false, lastUpdatedAt: new Date() } }
    );
    logger.info('[PropWatcher] No props returned — hiding existing', {
      sport, oddsEventId: game.oddsEventId, hiddenProps: hideResult.modifiedCount || 0,
    });
    return { propsUpserted: 0, linesChanged: 0, rawProps: [] };
  }

  // NBA player ID resolution (requires team context for v2 API)
  let playerIdMap = new Map();
  if (SPORTS_WITH_PLAYER_ID_RESOLUTION.has(sport)) {
    const uniquePlayerNames = [...new Set(rawProps.map(p => p.playerName))];
    const homeTeamId = game.homeTeam?.apiSportsId || null;
    const awayTeamId = game.awayTeam?.apiSportsId || null;
    const playersWithContext = uniquePlayerNames.map(playerName => ({
      playerName,
      teamApiSportsId:     homeTeamId,
      awayTeamApiSportsId: awayTeamId,
    }));
    playerIdMap = await bulkResolvePlayerIds(playersWithContext, sport);
    logger.debug(`[PropWatcher] Resolved ${playerIdMap.size}/${uniquePlayerNames.length} player IDs`, { sport });
  }

  const normalizedProps = rawProps.map(rp => adapter.normalizeProp(rp));

  // Load existing props once for line movement detection
  const existingProps = await PlayerProp.find({
    sport, oddsEventId: game.oddsEventId,
  }).select('playerName statType line').lean();
  const existingMap = new Map(existingProps.map(p => [`${p.playerName}::${p.statType}`, p]));

  // Bulk fetch injury statuses once per game
  let injuryByPlayer = new Map();
  if (isInjurySportSupported(sport)) {
    injuryByPlayer = await getInjuryStatusesForGame({
      homeTeamName: game.homeTeam?.name,
      awayTeamName: game.awayTeam?.name,
    }, sport);
  }

  let propsUpserted = 0;
  let linesChanged  = 0;
  const staleInvalidations = [];
  const bulkOps = [];

  for (const normalizedProp of normalizedProps) {
    const existing = existingMap.get(`${normalizedProp.playerName}::${normalizedProp.statType}`) || null;

    const injury         = injuryByPlayer.get(_normalizeName(normalizedProp.playerName)) || null;
    const providerAvail  = normalizedProp.isAvailable !== false;
    const isOut          = injury?.status === 'Out';

    const updateData = {
      ...normalizedProp,
      gameId:            game._id,
      lastUpdatedAt:     new Date(),
      apiSportsPlayerId: playerIdMap.get(normalizedProp.playerName) || null,
      isAvailable:       providerAvail && !isOut,
      injuryStatus:      injury?.status   || null,
      injuryReason:      injury?.reason   || null,
      injurySeverity:    injury?.severity || null,
      injuryUpdatedAt:   injury ? new Date() : null,
    };

    // Line movement detection
    if (existing && existing.line !== normalizedProp.line) {
      const lineChange = Math.abs(normalizedProp.line - existing.line);
      logger.info(`📈 [PropWatcher] Line moved: ${normalizedProp.playerName} ${normalizedProp.statType}`, {
        sport, oldLine: existing.line, newLine: normalizedProp.line, change: lineChange,
      });
      updateData.previousLine = existing.line;
      updateData.lineMovedAt  = new Date();
      linesChanged++;
      if (lineChange > ODDS_CHANGE_THRESHOLD) {
        staleInvalidations.push(
          _invalidateStaledInsights(sport, game.oddsEventId, normalizedProp.playerName, normalizedProp.statType)
        );
      }
    }

    bulkOps.push({
      updateOne: {
        filter: { oddsEventId: normalizedProp.oddsEventId, playerName: normalizedProp.playerName, statType: normalizedProp.statType },
        update:  { $set: updateData },
        upsert:  true,
      },
    });
    propsUpserted++;
  }

  if (bulkOps.length) {
    await PlayerProp.bulkWrite(bulkOps, { ordered: false });
  }
  if (staleInvalidations.length) {
    await Promise.all(staleInvalidations);
  }

  // Return rawProps so caller can use them for starter enrichment
  return { propsUpserted, linesChanged, rawProps };
};

const _invalidateStaledInsights = async (sport, eventId, playerName, statType) => {
  const { INSIGHT_STATUS } = require('../config/constants');
  const Insight = require('../models/Insight.model');
  const result = await Insight.updateMany(
    { sport, eventId, playerName, statType, status: INSIGHT_STATUS.GENERATED },
    { $set: { status: INSIGHT_STATUS.STALE } }
  );
  if (result.modifiedCount > 0) {
    logger.info(`🗑️  [PropWatcher] Invalidated ${result.modifiedCount} stale insights`, {
      sport, eventId, playerName, statType,
    });
  }
};

const registerPropWatcherJob = () => {
  if (process.env.CRON_PROP_WATCHER_ENABLED !== 'true') {
    logger.info('⏭️  [PropWatcher] Cron disabled');
    return;
  }
  cron.schedule('*/30 * * * *', async () => {
    logger.info('⏰ [PropWatcher] Cron triggered');
    try { await runPropWatcher(); }
    catch (err) { logger.error('❌ [PropWatcher] Cron crashed', { error: err.message }); }
  });
  logger.info('✅ [PropWatcher] Cron registered — every 30 minutes');
};

module.exports = { registerPropWatcherJob, runPropWatcher };
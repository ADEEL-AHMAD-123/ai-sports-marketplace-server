/**
 * soccer.propWatcher.js — Soccer-only prop fetching and scoring
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp = require('../../../models/PlayerProp.model');
const Insight = require('../../../models/Insight.model');
const StrategyService = require('../../../services/StrategyService');
const { getAdapter } = require('../../../services/shared/adapterRegistry');
const { cacheDel } = require('../../../config/redis');
const { ODDS_CHANGE_THRESHOLD, INSIGHT_STATUS } = require('../../../config/constants');
const logger = require('../../../config/logger');

const SPORT = 'soccer';

async function run() {
  logger.info(`👁️  [${SPORT.toUpperCase()}PropWatcher] Starting...`);
  const adapter = getAdapter(SPORT);

  const now = new Date();
  const games = await Game.find({
    sport: SPORT,
    oddsEventId: { $exists: true, $ne: null },
    startTime: { $gte: new Date(now.getTime() - 3 * 3600000), $lte: new Date(now.getTime() + 72 * 3600000) },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (!games.length) {
    logger.info(`[${SPORT}PropWatcher] No games`);
    return { upserted: 0 };
  }

  let totalUpserted = 0;

  for (const game of games) {
    const rawProps = await adapter.fetchProps(game.oddsEventId, { oddsSportKey: game.oddsSportKey });

    if (!rawProps.length) {
      await PlayerProp.updateMany(
        { sport: SPORT, oddsEventId: game.oddsEventId, isAvailable: true },
        { $set: { isAvailable: false, lastUpdatedAt: new Date() } }
      );
      await Game.findByIdAndUpdate(game._id, { hasProps: false, propsLastFetchedAt: new Date() });
      continue;
    }

    const bulkOps = rawProps.map((rp) => {
      const norm = adapter.normalizeProp(rp);
      return {
        updateOne: {
          filter: { oddsEventId: norm.oddsEventId, playerName: norm.playerName, statType: norm.statType },
          update: {
            $set: {
              ...norm,
              gameId: game._id,
              lastUpdatedAt: new Date(),
              homeTeamName: game.homeTeam?.name || null,
              awayTeamName: game.awayTeam?.name || null,
              focusStatAvg: norm.line || null,
              aiPredictedValue: norm.line || null,
              isAvailable: true,
            },
          },
          upsert: true,
        },
      };
    });

    await PlayerProp.bulkWrite(bulkOps, { ordered: false });
    await _invalidateMovedLines(game.oddsEventId, rawProps, adapter);

    await Game.findByIdAndUpdate(game._id, { hasProps: true, propsLastFetchedAt: new Date() });
    totalUpserted += bulkOps.length;
  }

  await StrategyService.scoreAllPropsForSport(SPORT);

  const dateKey = new Date().toISOString().split('T')[0];
  await cacheDel(`schedule:${SPORT}:${dateKey}`);

  for (const game of games) {
    for (const suffix of ['all', 'highConfidence', 'bestValue']) {
      await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
    }
  }

  logger.info(`✅ [${SPORT.toUpperCase()}PropWatcher] Done — ${totalUpserted} props`);
  return { upserted: totalUpserted };
}

async function _invalidateMovedLines(oddsEventId, rawProps, adapter) {
  const existing = await PlayerProp.find({ sport: SPORT, oddsEventId, isAvailable: true })
    .select('playerName statType line')
    .lean();
  const existingMap = new Map(existing.map((p) => [`${p.playerName}::${p.statType}`, p.line]));

  for (const rp of rawProps) {
    const norm = adapter.normalizeProp(rp);
    const prevLine = existingMap.get(`${norm.playerName}::${norm.statType}`);
    if (prevLine == null || !norm.line) continue;

    if (Math.abs(norm.line - prevLine) > ODDS_CHANGE_THRESHOLD) {
      await Insight.updateMany(
        {
          sport: SPORT,
          eventId: oddsEventId,
          playerName: norm.playerName,
          statType: norm.statType,
          status: INSIGHT_STATUS.GENERATED,
        },
        { $set: { status: INSIGHT_STATUS.STALE } }
      );
    }
  }
}

module.exports = { run };

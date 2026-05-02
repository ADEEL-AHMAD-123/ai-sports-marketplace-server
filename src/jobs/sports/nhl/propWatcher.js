/**
 * nhl.propWatcher.js — NHL-only prop fetching and scoring
 *
 * TO RUN STANDALONE:
 *   node -e "require('./nhl.propWatcher').run().then(r => console.log(r))"
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp             = require('../../../models/PlayerProp.model');
const { getAdapter }         = require('../../../services/shared/adapterRegistry');
const { cacheDel }           = require('../../../config/redis');
const logger                 = require('../../../config/logger');

const SPORT = 'nhl';

async function run() {
  logger.info(`👁️  [${SPORT.toUpperCase()}PropWatcher] Starting...`);
  const adapter = getAdapter(SPORT);

  const now = new Date();
  const games = await Game.find({
    sport:     SPORT,
    startTime: { $gte: new Date(now.getTime() - 3*3600000), $lte: new Date(now.getTime() + 72*3600000) },
    status:    { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (!games.length) { logger.info(`[${SPORT}PropWatcher] No games`); return { upserted: 0 }; }

  let totalUpserted = 0;

  for (const game of games) {
    const rawProps = await adapter.fetchProps(game.oddsEventId);
    if (!rawProps.length) continue;

    // NHL: no player ID resolution needed, name-based
    const bulkOps = rawProps.map(rp => {
      const norm = adapter.normalizeProp(rp);
      return {
        updateOne: {
          filter: { oddsEventId: norm.oddsEventId, playerName: norm.playerName, statType: norm.statType },
          update: { $set: {
              ...norm,
              gameId:        game._id,
              lastUpdatedAt: new Date(),
              homeTeamName:  game.homeTeam?.name || null,
              awayTeamName:  game.awayTeam?.name || null,
            } },
          upsert: true,
        },
      };
    });

    await PlayerProp.bulkWrite(bulkOps, { ordered: false });
    await Game.findByIdAndUpdate(game._id, { hasProps: true, propsLastFetchedAt: new Date() });
    totalUpserted += bulkOps.length;
  }

  // NHL has no player ID resolution yet — skip StrategyService scoring to prevent
  // all props being hidden (no apiSportsPlayerId → stats=null → isAvailable=false).
  // Props remain available (isAvailable:true from normalizeProp) without confidence scores.

  const dateKey = new Date().toISOString().split('T')[0];
  await cacheDel(`schedule:${SPORT}:${dateKey}`);
  for (const game of games) {
    for (const suffix of ['all', 'highConfidence', 'bestValue']) {
      await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
    }
  }

  logger.info(`✅ [${SPORT}PropWatcher] Done — ${totalUpserted} props`);
  return { upserted: totalUpserted };
}

module.exports = { run };

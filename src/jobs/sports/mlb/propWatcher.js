/**
 * mlb.propWatcher.js — MLB-only prop fetching, starter enrichment, and scoring
 *
 * TO RUN STANDALONE:
 *   node -e "require('./mlb.propWatcher').run().then(r => console.log(r))"
 */

const { Game, GAME_STATUS }  = require('../../../models/Game.model');
const PlayerProp              = require('../../../models/PlayerProp.model');
const Insight                 = require('../../../models/Insight.model');
const StrategyService         = require('../../../services/StrategyService');
const { getAdapter }          = require('../../../services/shared/adapterRegistry');
const { enrichBatterPropsWithStarter } = require('../../../services/sports/mlb/MLBStarterService');
const MLBInjuryService        = require('../../../services/sports/mlb/MLBInjuryService');
const { cacheDel }            = require('../../../config/redis');
const { ODDS_CHANGE_THRESHOLD, INSIGHT_STATUS } = require('../../../config/constants');
const logger                  = require('../../../config/logger');

const SPORT = 'mlb';

const normName = (n = '') => String(n).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

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

    const injuryMap = await MLBInjuryService.getInjuryMap({
      homeTeamName: game.homeTeam?.name,
      awayTeamName: game.awayTeam?.name,
    });

    const bulkOps = rawProps.map(rp => {
      const norm   = adapter.normalizeProp(rp);
      const injury = injuryMap.get(normName(norm.playerName)) || null;
      const isOut  = injury?.status === 'Out';
      return {
        updateOne: {
          filter: { oddsEventId: norm.oddsEventId, playerName: norm.playerName, statType: norm.statType },
          update: {
            $set: {
              ...norm,
              gameId:        game._id,
              lastUpdatedAt: new Date(),
              homeTeamName:  game.homeTeam?.name || null,
              awayTeamName:  game.awayTeam?.name || null,
              isAvailable:   !isOut,
              injuryStatus:  injury?.status || null,
              injuryReason:  injury?.reason || null,
              injuryUpdatedAt: injury ? new Date() : null,
            },
          },
          upsert: true,
        },
      };
    });

    await PlayerProp.bulkWrite(bulkOps, { ordered: false });

    // MLB-specific: enrich batter props with opponent starter context
    try {
      await enrichBatterPropsWithStarter(game, rawProps, PlayerProp);
    } catch (err) {
      logger.warn('[MLBPropWatcher] Starter enrichment failed (non-fatal)', { error: err.message });
    }

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

  logger.info(`✅ [${SPORT}PropWatcher] Done — ${totalUpserted} props`);
  return { upserted: totalUpserted };
}

async function _invalidateMovedLines(oddsEventId, rawProps, adapter) {
  const existing = await PlayerProp.find({ sport: SPORT, oddsEventId, isAvailable: true })
    .select('playerName statType line').lean();
  const existingMap = new Map(existing.map(p => [`${p.playerName}::${p.statType}`, p.line]));
  for (const rp of rawProps) {
    const norm     = adapter.normalizeProp(rp);
    const prevLine = existingMap.get(`${norm.playerName}::${norm.statType}`);
    if (prevLine == null || !norm.line) continue;
    // Per-stat threshold: K lines and tight lines use 0.5
    const threshold = ['pitcher_strikeouts'].includes(norm.statType) ? 0.5 : ODDS_CHANGE_THRESHOLD;
    if (Math.abs(norm.line - prevLine) > threshold) {
      await Insight.updateMany(
        { sport: SPORT, eventId: oddsEventId, playerName: norm.playerName, statType: norm.statType, status: 'generated' },
        { $set: { status: 'stale' } }
      );
    }
  }
}

module.exports = { run };


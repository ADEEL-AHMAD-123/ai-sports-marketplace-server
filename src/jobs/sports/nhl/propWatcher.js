/**
 * nhl.propWatcher.js — NHL-only prop fetching and scoring
 *
 * Per-prop enrichment:
 *  1. Resolve the player's NHL team (home/away) via NHLStatsClient roster lookup.
 *  2. Apply the latest injury map — Out players are marked unavailable so users
 *     don't see picks for scratched players.
 *
 * TO RUN STANDALONE:
 *   node -e "require('./nhl.propWatcher').run().then(r => console.log(r))"
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp             = require('../../../models/PlayerProp.model');
const StrategyService        = require('../../../services/StrategyService');
const { getAdapter }         = require('../../../services/shared/adapterRegistry');
const { cacheDel }           = require('../../../config/redis');
const logger                 = require('../../../config/logger');
const NHLInjuryService       = require('../../../services/sports/nhl/NHLInjuryService');
const NHLStatsClient         = require('../../../services/sports/nhl/NHLStatsClient');

const SPORT = 'nhl';

// Resolve playerTeam for a single (name, game) — best-effort; null on failure.
async function _resolvePlayerSide(playerName, homeTeamName, awayTeamName) {
  try {
    const info = await NHLStatsClient.resolvePlayerId(playerName, homeTeamName, awayTeamName);
    if (!info?.teamAbbrev) return { side: null, teamAbbrev: null };
    const homeAbbr = NHLStatsClient.getTeamAbbrev(homeTeamName);
    const awayAbbr = NHLStatsClient.getTeamAbbrev(awayTeamName);
    if (info.teamAbbrev === homeAbbr) return { side: 'home', teamAbbrev: homeAbbr };
    if (info.teamAbbrev === awayAbbr) return { side: 'away', teamAbbrev: awayAbbr };
    return { side: null, teamAbbrev: info.teamAbbrev };
  } catch {
    return { side: null, teamAbbrev: null };
  }
}

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
  let totalScratched = 0;

  for (const game of games) {
    const rawProps = await adapter.fetchProps(game.oddsEventId);
    if (!rawProps.length) continue;

    const homeName = game.homeTeam?.name || null;
    const awayName = game.awayTeam?.name || null;

    // Pre-fetch the injury map once per game (Map keyed by normalized name).
    const injuryMap = await NHLInjuryService.getInjuryMap({
      homeTeamName: homeName,
      awayTeamName: awayName,
      oddsEventId:  game.oddsEventId,
    }).catch(() => new Map());

    // De-duplicate name lookups: the same playerName appears across multiple
    // markets (goals/assists/shots/points). Resolve the player ↔ team mapping
    // once per (game, name).
    const normNames = new Map(); // normName -> originalName
    for (const rp of rawProps) {
      normNames.set(NHLStatsClient.normName(rp.playerName), rp.playerName);
    }

    const sideByNorm = new Map();
    await Promise.all(
      Array.from(normNames.entries()).map(async ([norm, original]) => {
        const resolved = await _resolvePlayerSide(original, homeName, awayName);
        sideByNorm.set(norm, resolved);
      })
    );

    const bulkOps = rawProps.map(rp => {
      const norm = adapter.normalizeProp(rp);
      const nName = NHLStatsClient.normName(norm.playerName);
      const sideInfo = sideByNorm.get(nName) || { side: null, teamAbbrev: null };
      const injury  = injuryMap.get(nName) || null;

      const isOut   = injury?.status === 'Out';
      if (isOut) totalScratched++;

      return {
        updateOne: {
          filter: { oddsEventId: norm.oddsEventId, playerName: norm.playerName, statType: norm.statType },
          update: {
            $set: {
              ...norm,
              gameId:        game._id,
              lastUpdatedAt: new Date(),
              homeTeamName:  homeName,
              awayTeamName:  awayName,
              teamName:      sideInfo.teamAbbrev || null,
              playerTeam:    sideInfo.side,                 // 'home' | 'away' | null
              isAvailable:   !isOut,
              injuryStatus:  injury?.status || null,
              injuryReason:  injury?.reason || null,
              injurySeverity: injury?.severity || null,
              injuryUpdatedAt: injury ? new Date() : null,
            },
          },
          upsert: true,
        },
      };
    });

    await PlayerProp.bulkWrite(bulkOps, { ordered: false });
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

  logger.info(`✅ [${SPORT}PropWatcher] Done — ${totalUpserted} props (${totalScratched} marked OUT)`);
  return { upserted: totalUpserted, scratched: totalScratched };
}

module.exports = { run };

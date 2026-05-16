/**
 * nba.propWatcher.js — NBA-only prop fetching and scoring
 *
 * TO RUN STANDALONE (test without affecting MLB/NHL):
 *   node -e "require('./nba.propWatcher').run().then(r => console.log(r))"
 *
 * TO TRIGGER FROM ADMIN PANEL:
 *   POST /api/admin/cron/prop-watcher-nba
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp             = require('../../../models/PlayerProp.model');
const Insight                = require('../../../models/Insight.model');
const { scoreSport }        = require('../../../services/queue/ScoringDispatcherService');
const { getAdapter }         = require('../../../services/shared/adapterRegistry');
const { bulkResolvePlayerIds, PlayerCache } = require('../../../utils/playerResolver');
const { getTeamAbbr }        = require('../../../services/shared/teamMaps');
const NBAInjuryService       = require('../../../services/sports/nba/NBAInjuryService');
const { cacheDel }           = require('../../../config/redis');
const { ODDS_CHANGE_THRESHOLD, INSIGHT_STATUS } = require('../../../config/constants');
const logger                 = require('../../../config/logger');

const SPORT = 'nba';

const normName = (n = '') => String(n).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();
const normTeam = (n = '') => String(n).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

function _inferPlayerSideFromTeamName(teamName, game) {
  if (!teamName || !game) return { side: null, teamAbbr: null };

  const src = normTeam(teamName);
  const homeName = game.homeTeam?.name || '';
  const awayName = game.awayTeam?.name || '';
  const homeNorm = normTeam(homeName);
  const awayNorm = normTeam(awayName);
  const homeAbbr = getTeamAbbr('nba', homeName);
  const awayAbbr = getTeamAbbr('nba', awayName);

  const isHome = (src === homeNorm) || src.includes(homeNorm) || homeNorm.includes(src) || src.includes(String(homeAbbr).toLowerCase());
  const isAway = (src === awayNorm) || src.includes(awayNorm) || awayNorm.includes(src) || src.includes(String(awayAbbr).toLowerCase());

  if (isHome && !isAway) return { side: 'home', teamAbbr: homeAbbr };
  if (isAway && !isHome) return { side: 'away', teamAbbr: awayAbbr };
  return { side: null, teamAbbr: null };
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

  for (const game of games) {
    const rawProps = await adapter.fetchProps(game.oddsEventId);
    if (!rawProps.length) continue;

    // NBA requires team param for player ID resolution
    const uniqueNames = [...new Set(rawProps.map(p => p.playerName))];
    const playerIdMap = await bulkResolvePlayerIds(
      uniqueNames.map(playerName => ({
        playerName,
        teamApiSportsId:     game.homeTeam?.apiSportsId || null,
        awayTeamApiSportsId: game.awayTeam?.apiSportsId || null,
      })),
      SPORT
    );

    const cachedPlayers = await PlayerCache.find({
      sport: SPORT,
      oddsApiName: { $in: uniqueNames.map(normName) },
    }).select('oddsApiName teamName').lean();
    const cachedTeamByName = new Map(cachedPlayers.map((p) => [p.oddsApiName, p.teamName || null]));

    const injuryMap = await NBAInjuryService.getInjuryMap({
      homeTeamName: game.homeTeam?.name,
      awayTeamName: game.awayTeam?.name,
      oddsEventId:  game.oddsEventId,
    });

    const bulkOps = rawProps.map(rp => {
      const norm    = adapter.normalizeProp(rp);
      const injury  = injuryMap.get(normName(norm.playerName)) || null;
      const isOut   = injury?.status === 'Out';
      const cacheTeamName = cachedTeamByName.get(normName(norm.playerName)) || null;
      const sideInfo = _inferPlayerSideFromTeamName(cacheTeamName, game);
      return {
        updateOne: {
          filter: { oddsEventId: norm.oddsEventId, playerName: norm.playerName, statType: norm.statType },
          update: {
            $set: {
              ...norm,
              gameId:             game._id,
              lastUpdatedAt:      new Date(),
              homeTeamName:       game.homeTeam?.name   || null,
              awayTeamName:       game.awayTeam?.name   || null,
              teamName:           sideInfo.teamAbbr || null,
              playerTeam:         sideInfo.side,
              apiSportsPlayerId:  playerIdMap.get(norm.playerName) || null,
              isAvailable:        !isOut,
              injuryStatus:       injury?.status   || null,
              injuryReason:       injury?.reason   || null,
              injuryUpdatedAt:    injury ? new Date() : null,
            },
          },
          upsert: true,
        },
      };
    });

    await PlayerProp.bulkWrite(bulkOps, { ordered: false });

    // Invalidate stale insights on significant line moves
    await _invalidateMovedLines(game.oddsEventId, rawProps, adapter);

    await Game.findByIdAndUpdate(game._id, { hasProps: true, propsLastFetchedAt: new Date() });
    totalUpserted += bulkOps.length;
  }

    await scoreSport(SPORT, 'nba.propWatcher');

  // Clear Redis schedule + prop caches
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
    const norm    = adapter.normalizeProp(rp);
    const prevLine = existingMap.get(`${norm.playerName}::${norm.statType}`);
    if (prevLine == null || !norm.line) continue;
    const delta = Math.abs(norm.line - prevLine);
    if (delta > ODDS_CHANGE_THRESHOLD) {
      await Insight.updateMany(
        { sport: SPORT, eventId: oddsEventId, playerName: norm.playerName, statType: norm.statType, status: INSIGHT_STATUS.GENERATED },
        { $set: { status: INSIGHT_STATUS.STALE } }
      );
    }
  }
}

module.exports = { run };


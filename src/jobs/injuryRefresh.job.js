/**
 * injuryRefresh.job.js — Near-game injury freshness updater
 *
 * Purpose:
 *  - Keep injury statuses fresh near game time without adding API latency to request path.
 *  - Only updates props whose injury fields are stale.
 *
 * Behavior:
 *  - Runs on a short schedule (default every 5 minutes)
 *  - Targets injury-supported sports only
 *  - Targets games within a configurable lookahead window
 */

const cron = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const PlayerProp = require('../models/PlayerProp.model');
const { getActiveSports } = require('../services/shared/adapterRegistry');
const { getInjuryStatusesForGame, isInjurySportSupported } = require('../services/injuryService');
const logger = require('../config/logger');

const DEFAULT_SCHEDULE = '*/5 * * * *';
const LOOKAHEAD_MINUTES = parseInt(process.env.INJURY_REFRESH_LOOKAHEAD_MINUTES || '120', 10);
const STALE_MINUTES = parseInt(process.env.INJURY_REFRESH_STALE_MINUTES || '15', 10);

const _normalizePlayerNameKey = (name = '') => String(name)
  .toLowerCase()
  .replace(/[.'\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const runInjuryRefreshCycle = async () => {
  const activeSports = getActiveSports().filter((sport) => isInjurySportSupported(sport));
  if (!activeSports.length) return;

  const now = new Date();
  const windowStart = new Date(now.getTime() - (30 * 60 * 1000));
  const windowEnd = new Date(now.getTime() + (LOOKAHEAD_MINUTES * 60 * 1000));

  let refreshedGames = 0;
  let refreshedProps = 0;

  for (const sport of activeSports) {
    const games = await Game.find({
      sport,
      startTime: { $gte: windowStart, $lte: windowEnd },
      status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
    })
      .select('_id oddsEventId homeTeam.name awayTeam.name startTime')
      .lean();

    for (const game of games) {
      try {
        const updatedCount = await _refreshGameInjuries(sport, game, now);
        refreshedGames++;
        refreshedProps += updatedCount;
      } catch (err) {
        logger.warn('[InjuryRefresh] Failed for game', {
          sport,
          oddsEventId: game.oddsEventId,
          error: err.message,
        });
      }
    }
  }

  logger.info('[InjuryRefresh] Cycle complete', {
    activeSports: activeSports.length,
    refreshedGames,
    refreshedProps,
    staleMinutes: STALE_MINUTES,
    lookaheadMinutes: LOOKAHEAD_MINUTES,
  });
};

const _refreshGameInjuries = async (sport, game, now = new Date()) => {
  const staleBefore = new Date(now.getTime() - (STALE_MINUTES * 60 * 1000));
  const injuryByPlayer = await getInjuryStatusesForGame(
    {
      homeTeamName: game.homeTeam?.name,
      awayTeamName: game.awayTeam?.name,
    },
    sport
  );

  const props = await PlayerProp.find({
    sport,
    oddsEventId: game.oddsEventId,
  })
    .select('_id playerName isAvailable injuryUpdatedAt injuryStatus injuryReason injurySeverity')
    .lean();

  if (!props.length) return 0;

  const bulkOps = [];
  for (const prop of props) {
    // Refresh only stale injury fields.
    if (prop.injuryUpdatedAt && prop.injuryUpdatedAt > staleBefore) continue;

    const injury = injuryByPlayer.get(_normalizePlayerNameKey(prop.playerName)) || null;
    const nextStatus = injury?.status || null;
    const nextReason = injury?.reason || null;
    const nextSeverity = injury?.severity || null;

    // Never reopen markets here; watcher controls provider availability state.
    const nextAvailable = nextStatus === 'Out' ? false : prop.isAvailable;

    bulkOps.push({
      updateOne: {
        filter: { _id: prop._id },
        update: {
          $set: {
            isAvailable: nextAvailable,
            injuryStatus: nextStatus,
            injuryReason: nextReason,
            injurySeverity: nextSeverity,
            injuryUpdatedAt: now,
            lastUpdatedAt: now,
          },
        },
      },
    });
  }

  if (!bulkOps.length) return 0;

  const result = await PlayerProp.bulkWrite(bulkOps, { ordered: false });
  return (result.modifiedCount || 0) + (result.upsertedCount || 0);
};

const registerInjuryRefreshJob = () => {
  if (process.env.CRON_INJURY_REFRESH_ENABLED !== 'true') {
    logger.info('⏭️  [InjuryRefresh] Cron disabled via CRON_INJURY_REFRESH_ENABLED=false');
    return;
  }

  const schedule = process.env.CRON_INJURY_REFRESH_SCHEDULE || DEFAULT_SCHEDULE;

  cron.schedule(schedule, async () => {
    logger.info('⏰ [InjuryRefresh] Cron triggered');
    try {
      await runInjuryRefreshCycle();
    } catch (err) {
      logger.error('❌ [InjuryRefresh] Cron cycle failed', { error: err.message });
    }
  });

  logger.info('✅ [InjuryRefresh] Cron registered', {
    schedule,
    staleMinutes: STALE_MINUTES,
    lookaheadMinutes: LOOKAHEAD_MINUTES,
  });
};

module.exports = {
  registerInjuryRefreshJob,
  runInjuryRefreshCycle,
};

/**
 * mlb.propWatcher.js — MLB-only prop fetching, starter enrichment, and scoring
 *
 * TO RUN STANDALONE:
 *   node -e "require('./mlb.propWatcher').run().then(r => console.log(r))"
 */

const { Game, GAME_STATUS }  = require('../../../models/Game.model');
const PlayerProp              = require('../../../models/PlayerProp.model');
const Insight                 = require('../../../models/Insight.model');
const { scoreSport }         = require('../../../services/queue/ScoringDispatcherService');
const { getAdapter }          = require('../../../services/shared/adapterRegistry');
const { enrichBatterPropsWithStarter } = require('../../../services/sports/mlb/MLBStarterService');
const MLBInjuryService        = require('../../../services/sports/mlb/MLBInjuryService');
const { cacheDel }            = require('../../../config/redis');
const { ODDS_CHANGE_THRESHOLD, INSIGHT_STATUS } = require('../../../config/constants');
const { shouldFetchPropsForGame, getPropFetchWindow } = require('../shared/propPollingPolicy');
const { getEngagedEventIds } = require('../shared/propEngagement');
const logger                  = require('../../../config/logger');

const SPORT = 'mlb';

const normName = (n = '') => String(n).toLowerCase().replace(/[.'\-]/g, ' ').replace(/\s+/g, ' ').trim();

async function run() {
  logger.info(`👁️  [${SPORT.toUpperCase()}PropWatcher] Starting...`);
  const adapter = getAdapter(SPORT);

  const now = new Date();
  const { start, end } = getPropFetchWindow(now);
  const games = await Game.find({
    sport:     SPORT,
    startTime: { $gte: start, $lte: end },
    status:    { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (!games.length) { logger.info(`[${SPORT}PropWatcher] No games`); return { upserted: 0 }; }

  // Engaged games (insights / recent views) earn the fast 10-min cadence.
  const engagedEventIds = await getEngagedEventIds(games, now);

  // Diagnostic counters so a "Done — 0 props" outcome can be traced to a
  // specific reason without adding logs after the fact.
  let totalUpserted   = 0;
  let skippedByPolicy = 0;   // shouldFetchPropsForGame returned false
  let skippedEmpty    = 0;   // adapter returned [] (empty markets OR quota-safe skip)
  let attempted       = 0;   // fetch calls actually made

  for (const game of games) {
    const engaged = engagedEventIds.has(String(game.oddsEventId));
    if (!shouldFetchPropsForGame(game, now, { engaged })) {
      skippedByPolicy += 1;
      continue;
    }

    attempted += 1;
    const rawProps = await adapter.fetchProps(game.oddsEventId);
    if (!rawProps.length) {
      // Empty response — could be "sportsbook has no markets right now"
      // (in-play, mid-inning, closed early) OR the adapter quota-safed the
      // call. Mark the game so the frontend chip stays honest ("Lines
      // Pending") AND set propsLastFetchedAt so we don't hammer the API
      // during a run where quota is exhausted.
      await Game.findByIdAndUpdate(game._id, {
        hasProps: false,
        propsLastFetchedAt: new Date(),
      });
      skippedEmpty += 1;
      continue;
    }

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

  await scoreSport(SPORT, 'mlb.propWatcher');

  const dateKey = new Date().toISOString().split('T')[0];
  await cacheDel(`schedule:${SPORT}:${dateKey}`);
  for (const game of games) {
    for (const suffix of ['all', 'highConfidence', 'bestValue']) {
      await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
    }
  }

  // Rich Done line — with counters you can immediately tell whether a
  // 0-upsert result was "policy skipped everything", "quota exhausted",
  // "The Odds API had no markets", or a real successful upsert.
  const quotaRemaining = Number.isFinite(adapter.oddsApiQuotaRemaining)
    ? adapter.oddsApiQuotaRemaining
    : 'unknown';
  logger.info(
    `✅ [${SPORT}PropWatcher] Done — ${totalUpserted} props ` +
    `(games=${games.length}, attempted=${attempted}, ` +
    `skippedByPolicy=${skippedByPolicy}, skippedEmpty=${skippedEmpty}, ` +
    `engaged=${engagedEventIds.size}, oddsApiQuotaRemaining=${quotaRemaining})`
  );
  return {
    upserted: totalUpserted,
    games: games.length,
    attempted,
    skippedByPolicy,
    skippedEmpty,
    engaged: engagedEventIds.size,
    oddsApiQuotaRemaining: quotaRemaining,
  };
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


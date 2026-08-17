/**
 * soccer.propWatcher.js — Soccer-only prop fetching and scoring
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const PlayerProp = require('../../../models/PlayerProp.model');
const Insight = require('../../../models/Insight.model');
const { scoreSport } = require('../../../services/queue/ScoringDispatcherService');
const { getAdapter } = require('../../../services/shared/adapterRegistry');
const SoccerInjuryService = require('../../../services/sports/soccer/SoccerInjuryService');
const { cacheDel } = require('../../../config/redis');
const { ODDS_CHANGE_THRESHOLD, INSIGHT_STATUS } = require('../../../config/constants');
const { shouldFetchPropsForGame, getPropFetchWindow } = require('../shared/propPollingPolicy');
const { getEngagedEventIds } = require('../shared/propEngagement');
const logger = require('../../../config/logger');

const SPORT = 'soccer';
const GAME_PROCESS_CONCURRENCY = Math.max(1, parseInt(process.env.SOCCER_PROP_WATCHER_CONCURRENCY || '6', 10));
const normName = (n = '') => String(n)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[.'\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function run() {
  logger.info(`👁️  [${SPORT.toUpperCase()}PropWatcher] Starting...`);
  const adapter = getAdapter(SPORT);

  const now = new Date();
  const { start, end } = getPropFetchWindow(now);
  const games = await Game.find({
    sport: SPORT,
    oddsEventId: { $exists: true, $ne: null },
    startTime: { $gte: start, $lte: end },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();

  if (!games.length) {
    logger.info(`[${SPORT}PropWatcher] No games`);
    return { upserted: 0 };
  }

  // Engaged games (insights / recent views) earn the fast 10-min cadence.
  const engagedEventIds = await getEngagedEventIds(games, now);

  let totalUpserted = 0;
  const touchedEventIds = new Set();

  // ── Team-logo backfill (runs across the FULL display window) ─────────
  // The propWatcher's `games` list is scoped to the 48h track window — so
  // limiting backfill to those games would leave MLS games 3-7 days out
  // showing blank crests on the slate even though the frontend renders
  // them. Query the wider display window (matches GAME_LIST_WINDOW_HOURS
  // used by odds.controller.getGames) so every game the user can see gets
  // a logo backfill attempt.
  //
  // Cost: zero new Odds API calls; a Redis GET per league (cached 24h,
  // with a previous-season fallback if the current season is empty) plus
  // a Mongo update only when a logo actually changed.
  const backfillWindowHours = Math.max(48, parseInt(process.env.GAME_LIST_WINDOW_HOURS || '168', 10));
  const backfillEnd = new Date(now.getTime() + backfillWindowHours * 60 * 60 * 1000);
  const displayWindowGames = await Game.find({
    sport: SPORT,
    oddsEventId: { $exists: true, $ne: null },
    startTime: { $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000), $lte: backfillEnd },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
    $or: [
      { 'homeTeam.logoUrl': { $in: [null, ''] } },
      { 'awayTeam.logoUrl': { $in: [null, ''] } },
      { 'homeTeam.logoUrl': { $exists: false } },
      { 'awayTeam.logoUrl': { $exists: false } },
    ],
  }).lean();
  await _backfillTeamLogos(displayWindowGames, adapter, logger);

  const results = await _mapGamesWithConcurrency(games, async (game) => {
    try {
      const engaged = engagedEventIds.has(String(game.oddsEventId));
      if (!shouldFetchPropsForGame(game, now, { engaged })) {
        return { upserted: 0, touchedEventId: null, outcome: 'skippedByPolicy' };
      }

      const [rawProps, injuryMap] = await Promise.all([
        adapter.fetchProps(game.oddsEventId, { oddsSportKey: game.oddsSportKey }),
        SoccerInjuryService.getInjuryMap({
          leagueId: game.leagueId,
          startTime: game.startTime,
          homeTeamName: game.homeTeam?.name,
          awayTeamName: game.awayTeam?.name,
          homeTeamApiSportsId: game.homeTeam?.apiSportsId,
          awayTeamApiSportsId: game.awayTeam?.apiSportsId,
          oddsEventId: game.oddsEventId,
        }).catch(() => new Map()),
      ]);

      if (!rawProps.length) {
        await PlayerProp.updateMany(
          { sport: SPORT, oddsEventId: game.oddsEventId, isAvailable: true },
          { $set: { isAvailable: false, lastUpdatedAt: new Date() } }
        );
        await Game.findByIdAndUpdate(game._id, { hasProps: false, propsLastFetchedAt: new Date() });
        return { upserted: 0, touchedEventId: null, outcome: 'skippedEmpty' };
      }

      const bulkOps = rawProps.map((rp) => {
        const norm = adapter.normalizeProp(rp);
        const injury = injuryMap.get(normName(norm.playerName)) || null;
        const isOut = injury?.status === 'Out';
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
                isAvailable: !isOut,
                injuryStatus: injury?.status || null,
                injuryReason: injury?.reason || null,
                injurySeverity: injury?.severity || null,
                injuryUpdatedAt: injury ? new Date() : null,
              },
            },
            upsert: true,
          },
        };
      });

      await PlayerProp.bulkWrite(bulkOps, { ordered: false });
      await _invalidateMovedLines(game.oddsEventId, rawProps, adapter);
      await Game.findByIdAndUpdate(game._id, { hasProps: true, propsLastFetchedAt: new Date() });

      return { upserted: bulkOps.length, touchedEventId: game.oddsEventId, outcome: 'upserted' };
    } catch (err) {
      logger.error('[SOCCERPropWatcher] Game processing failed', {
        oddsEventId: game.oddsEventId,
        homeTeam: game.homeTeam?.name,
        awayTeam: game.awayTeam?.name,
        error: err.message,
      });
      return { upserted: 0, touchedEventId: null, outcome: 'failed' };
    }
  });

  // Aggregate per-game outcomes into totals for the diagnostic summary.
  let skippedByPolicy = 0;
  let skippedEmpty    = 0;
  let attempted       = 0;
  for (const result of results) {
    totalUpserted += result?.upserted || 0;
    if (result?.touchedEventId) touchedEventIds.add(result.touchedEventId);
    if (result?.outcome === 'skippedByPolicy') skippedByPolicy += 1;
    if (result?.outcome === 'skippedEmpty')    { skippedEmpty += 1; attempted += 1; }
    if (result?.outcome === 'upserted')        attempted += 1;
  }

  await scoreSport(SPORT, 'soccer.propWatcher', { eventIds: [...touchedEventIds] });

  const dateKey = new Date().toISOString().split('T')[0];
  await cacheDel(`schedule:${SPORT}:${dateKey}`);

  for (const game of games) {
    for (const suffix of ['all', 'highConfidence', 'bestValue']) {
      await cacheDel(`props:${SPORT}:${game.oddsEventId}:${suffix}`);
    }
  }

  const quotaRemaining = Number.isFinite(adapter.oddsApiQuotaRemaining)
    ? adapter.oddsApiQuotaRemaining : 'unknown';
  logger.info(
    `✅ [${SPORT.toUpperCase()}PropWatcher] Done — ${totalUpserted} props ` +
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

/**
 * Backfill missing team logos on any game in the tracked window.
 *
 * Runs BEFORE the polling-policy gate so games we won't fetch this cycle
 * (typically anything outside the 30h refresh window) still get their
 * crests. Bounded cost: one Redis GET per unique league (24h cached) +
 * one Mongo update per game that actually needed a change.
 *
 * A game is a backfill candidate when EITHER team is missing logoUrl AND
 * the game has a resolvable leagueId. We batch the directory lookup per
 * league so a 78-game slate across 6 leagues does at most 6 Redis reads.
 */
async function _backfillTeamLogos(games, adapter, log) {
  const needFill = games.filter((g) => (
    g?.leagueId && (!g.homeTeam?.logoUrl || !g.awayTeam?.logoUrl)
  ));

  // Games that need backfill but have no leagueId — flag once so we know
  // the data is malformed rather than silently ignoring.
  const missingLeagueId = games.filter((g) => (
    !g?.leagueId && (!g.homeTeam?.logoUrl || !g.awayTeam?.logoUrl)
  ));
  if (missingLeagueId.length) {
    log.warn(
      `[SOCCERPropWatcher] ${missingLeagueId.length} game(s) missing leagueId — cannot backfill logos. ` +
      `Re-run morning-scraper to re-normalize.`
    );
  }

  if (!needFill.length) {
    log.info(`[SOCCERPropWatcher] Logo backfill — no candidates (${games.length} games all have logos)`);
    return;
  }

  const uniqueLeagueIds = [...new Set(needFill.map((g) => g.leagueId))];
  const seasonYear = adapter._defaultSeasonYear();
  log.info(
    `[SOCCERPropWatcher] Logo backfill starting — ${needFill.length} candidate game(s) across ${uniqueLeagueIds.length} league(s), season ${seasonYear}`
  );

  const directoryByLeague = new Map();
  await Promise.all(uniqueLeagueIds.map(async (leagueId) => {
    try {
      const dir = await adapter._getLeagueTeamDirectory(leagueId, seasonYear);
      const size = dir ? Object.keys(dir).length : 0;
      log.info(`[SOCCERPropWatcher] Directory for league ${leagueId}: ${size} teams`);
      directoryByLeague.set(leagueId, dir || {});
    } catch (err) {
      log.warn(`[SOCCERPropWatcher] Directory fetch FAILED for league ${leagueId} — ${err.message}`);
      directoryByLeague.set(leagueId, null);
    }
  }));

  let fixed         = 0;
  let noMatch       = 0;
  let noDirectory   = 0;
  const missedNames = new Set();

  await Promise.all(needFill.map(async (game) => {
    const directory = directoryByLeague.get(game.leagueId);
    if (!directory || Object.keys(directory).length === 0) { noDirectory += 1; return; }

    try {
      const homeMissing = !game.homeTeam?.logoUrl;
      const awayMissing = !game.awayTeam?.logoUrl;
      const refreshedHome = homeMissing && game.homeTeam?.name
        ? adapter._resolveTeamFromDirectory(game.homeTeam.name, directory)
        : null;
      const refreshedAway = awayMissing && game.awayTeam?.name
        ? adapter._resolveTeamFromDirectory(game.awayTeam.name, directory)
        : null;
      const updates = {};
      if (refreshedHome?.logoUrl && refreshedHome.logoUrl !== game.homeTeam?.logoUrl) {
        updates.homeTeam = { ...game.homeTeam, ...refreshedHome };
      } else if (homeMissing && game.homeTeam?.name) {
        missedNames.add(game.homeTeam.name);
      }
      if (refreshedAway?.logoUrl && refreshedAway.logoUrl !== game.awayTeam?.logoUrl) {
        updates.awayTeam = { ...game.awayTeam, ...refreshedAway };
      } else if (awayMissing && game.awayTeam?.name) {
        missedNames.add(game.awayTeam.name);
      }
      if (Object.keys(updates).length) {
        await Game.findByIdAndUpdate(game._id, { $set: updates });
        Object.assign(game, updates);
        fixed += 1;
      } else {
        noMatch += 1;
      }
    } catch (err) {
      log.warn('[SOCCERPropWatcher] Per-game backfill failed', {
        oddsEventId: game.oddsEventId, error: err.message,
      });
    }
  }));

  log.info(
    `[SOCCERPropWatcher] Logo backfill — fixed=${fixed}, noMatch=${noMatch}, noDirectory=${noDirectory}` +
    (missedNames.size ? `, unmatchedTeams=[${[...missedNames].slice(0, 10).join(', ')}${missedNames.size > 10 ? '…' : ''}]` : '')
  );
}

async function _mapGamesWithConcurrency(games, worker) {
  const results = new Array(games.length);
  let cursor = 0;

  const runNext = async () => {
    while (cursor < games.length) {
      const index = cursor++;
      results[index] = await worker(games[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(GAME_PROCESS_CONCURRENCY, games.length) }, () => runNext())
  );

  return results;
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

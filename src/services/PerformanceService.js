/**
 * PerformanceService.js — Public + admin accuracy reporting
 *
 * Builds on top of InsightOutcomeService (which already grades insights when
 * games finalize). This service exposes three queries:
 *
 *  1. getRecentSuccesses({ limit, perSportMin })
 *     Public-facing. Returns the most recent N successful (win) insights
 *     across all sports. Implements fair distribution: every supported sport
 *     contributes at least `perSportMin` items if it has any wins; the
 *     remaining slots are filled with the most-recent winners overall.
 *     Used by ScoutClosings and the Hero carousel.
 *
 *  2. getPerGameReport({ sport, days, page, limit })
 *     Admin. Aggregates graded insights by game (eventId) and returns a
 *     paginated list with each game's win/loss/push counts, win rate, and
 *     basic game metadata. Lets admins drill into per-game accuracy.
 *
 *  3. getGameDetail(eventId)
 *     Admin. Full insight roster for one game with each insight's actual
 *     value, line, recommendation, and result.
 *
 * CACHING
 *  Both public methods are cached in Redis with short TTLs (5 min) keyed by
 *  the query params. The admin queries are not cached (admins want truth
 *  immediately).
 *
 * LIFECYCLE
 *  Graded insights persist indefinitely — they ARE the trust data. Only
 *  ungraded `retry_exhausted` rows older than RETRY_EXHAUSTED_PRUNE_DAYS
 *  are pruned by `pruneExhaustedRetries()` (called from a daily cron).
 */

const Insight            = require('../models/Insight.model');
const { Game }           = require('../models/Game.model');
const PerformanceArchive = require('../models/PerformanceArchive.model');
const { ACTIVE_SPORTS }  = require('../config/constants');
const { cacheGet, cacheSet } = require('../config/redis');
const logger             = require('../config/logger');

// All five active sports — pulled from constants so the source of truth
// stays single. NBA, MLB, NHL, NFL, Soccer.
const SUPPORTED_SPORTS = ACTIVE_SPORTS;

// Cache TTLs (seconds)
const TTL_RECENT_SUCCESSES = 5 * 60;   // 5 min — refreshes shortly after grading
const TTL_PER_GAME_REPORT  = 0;        // admin: never cache

// Lifecycle
const RETRY_EXHAUSTED_PRUNE_DAYS = 14;
const GRADED_RETENTION_DAYS      = parseInt(process.env.GRADED_RETENTION_DAYS || '90', 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Map a graded Insight document into the lean public-card shape used by
 * ScoutClosings / hero. Hides all internal/sensitive fields.
 */
function _toPublicSuccessCard(insight, game, opts = {}) {
  const ctx = insight.leagueContext || {};
  const homeTeam = ctx.homeTeam || game?.homeTeam?.name || null;
  const awayTeam = ctx.awayTeam || game?.awayTeam?.name || null;
  const homeAbbr = ctx.homeAbbr || game?.homeTeam?.abbreviation || null;
  const awayAbbr = ctx.awayAbbr || game?.awayTeam?.abbreviation || null;
  const homeLogoUrl = game?.homeTeam?.logoUrl || null;
  const awayLogoUrl = game?.awayTeam?.logoUrl || null;
  const matchup  = (awayAbbr && homeAbbr) ? `${awayAbbr} vs ${homeAbbr}` :
                   (awayTeam && homeTeam) ? `${awayTeam} vs ${homeTeam}` : null;

  // Insights returned via getRecentPublicInsights may not be graded yet —
  // surface their actual outcome state so the UI can label them correctly.
  const result = opts.result
    || (insight.outcomeResult === 'win'  ? 'HIT'
       : insight.outcomeResult === 'loss' ? 'MISS'
       : insight.outcomeResult === 'push' ? 'PUSH'
       : null);

  return {
    id:            String(insight._id),
    sport:         insight.sport,
    league:        insight.sport ? insight.sport.toUpperCase() : null,
    player:        insight.playerName,
    statType:      insight.statType,
    line:          insight.bettingLine,
    recommendation: insight.recommendation,                    // 'over' | 'under'
    actual:        num(insight.outcomeActual),
    edge:          num(insight.edgePercentage) != null
      ? `${insight.edgePercentage > 0 ? '+' : ''}${Number(insight.edgePercentage).toFixed(1)}%` : null,
    confidence:    num(insight.confidenceScore),
    isHighConfidence: !!insight.isHighConfidence,
    isBestValue:      !!insight.isBestValue,
    result,
    gameDate:      insight.outcomeGradedAt || game?.startTime || insight.createdAt,
    matchup,
    homeTeam,
    awayTeam,
    homeAbbr,
    awayAbbr,
    homeLogoUrl,
    awayLogoUrl,
    summary:       insight.insightSummary || null,
  };
}

/**
 * Fair-distribution allocator: given winners by sport and a target limit,
 * pick at least `perSportMin` from each (if available) and fill remaining
 * slots with the most-recent winners across all sports, deduped.
 *
 * @param {Map<string, Array>} bySport
 * @param {number} limit
 * @param {number} perSportMin
 */
function _distribute(bySport, limit, perSportMin) {
  const picked = [];
  const usedIds = new Set();

  // Phase 1 — guarantee perSportMin per sport (when sport has wins)
  for (const sport of SUPPORTED_SPORTS) {
    const winners = bySport.get(sport) || [];
    let taken = 0;
    for (const w of winners) {
      if (taken >= perSportMin) break;
      if (picked.length >= limit) break;
      const key = String(w._id);
      if (usedIds.has(key)) continue;
      picked.push(w);
      usedIds.add(key);
      taken += 1;
    }
  }

  // Phase 2 — fill remaining slots from a flat, date-sorted pool
  if (picked.length < limit) {
    const flat = [];
    for (const list of bySport.values()) flat.push(...list);
    flat.sort((a, b) =>
      new Date(b.outcomeGradedAt || b.createdAt) - new Date(a.outcomeGradedAt || a.createdAt)
    );
    for (const w of flat) {
      if (picked.length >= limit) break;
      const key = String(w._id);
      if (usedIds.has(key)) continue;
      picked.push(w);
      usedIds.add(key);
    }
  }

  // Final order: most-recent first
  picked.sort((a, b) =>
    new Date(b.outcomeGradedAt || b.createdAt) - new Date(a.outcomeGradedAt || a.createdAt)
  );
  return picked;
}

// ─── Class ────────────────────────────────────────────────────────────────────

class PerformanceService {
  /**
   * Recent successful predictions across sports.
   * Public-safe — no auth required.
   *
   * @param {Object} opts
   * @param {number} [opts.limit=10]
   * @param {number} [opts.perSportMin=2]
   * @param {number} [opts.sinceDays=45]
   * @returns {Promise<{ items: Array, total: number, hitRate: number|null, perSport: Object }>}
   */
  async getRecentSuccesses({ limit = 10, perSportMin = 2, sinceDays = 45 } = {}) {
    const cacheKey = `perf:scout-successes:v1:${limit}:${perSportMin}:${sinceDays}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);

    // Pull all wins in window — capped to a sane upper bound to keep memory low.
    // Selecting only fields we actually surface keeps payloads small.
    const wins = await Insight.find({
      status:        'generated',
      outcomeResult: 'win',
      outcomeGradedAt: { $gte: since },
    })
      .sort({ outcomeGradedAt: -1, createdAt: -1 })
      .limit(200)
      .select('sport eventId playerName statType bettingLine recommendation '
            + 'confidenceScore edgePercentage outcomeActual outcomeGradedAt createdAt '
            + 'insightSummary isHighConfidence isBestValue leagueContext')
      .lean();

    if (!wins.length) {
      const empty = { items: [], total: 0, hitRate: null, perSport: {} };
      await cacheSet(cacheKey, empty, TTL_RECENT_SUCCESSES);
      return empty;
    }

    // Group by sport
    const bySport = new Map();
    for (const w of wins) {
      if (!w.sport) continue;
      if (!bySport.has(w.sport)) bySport.set(w.sport, []);
      bySport.get(w.sport).push(w);
    }

    const picked = _distribute(bySport, limit, perSportMin);

    // Pull game metadata for matchup display (one query, all events)
    const eventIds = [...new Set(picked.map(w => w.eventId).filter(Boolean))];
    const games    = eventIds.length
      ? await Game.find({ oddsEventId: { $in: eventIds } })
          .select('oddsEventId homeTeam awayTeam startTime').lean()
      : [];
    const gameByEvent = new Map(games.map(g => [g.oddsEventId, g]));

    // Aggregate hit rate — blend the live (rolling-window) count with
    // archived lifetime counters so the public hit-rate stays accurate
    // even after old graded insights are pruned. Single $facet pipeline.
    const liveAggResult = await Insight.aggregate([
      { $match: { status: 'generated', outcomeResult: { $in: ['win', 'loss', 'push'] } } },
      {
        $group: {
          _id: null,
          wins:    { $sum: { $cond: [{ $eq: ['$outcomeResult', 'win']  }, 1, 0] } },
          losses:  { $sum: { $cond: [{ $eq: ['$outcomeResult', 'loss'] }, 1, 0] } },
          pushes:  { $sum: { $cond: [{ $eq: ['$outcomeResult', 'push'] }, 1, 0] } },
        },
      },
    ]);
    const live = liveAggResult[0] || { wins: 0, losses: 0, pushes: 0 };

    const archives  = await PerformanceArchive.find({}).select('wins losses pushes').lean();
    const archived  = archives.reduce((acc, a) => {
      acc.wins   += a.wins   || 0;
      acc.losses += a.losses || 0;
      acc.pushes += a.pushes || 0;
      return acc;
    }, { wins: 0, losses: 0, pushes: 0 });

    const lifetimeWins     = live.wins   + archived.wins;
    const lifetimeLosses   = live.losses + archived.losses;
    const lifetimePushes   = live.pushes + archived.pushes;
    const lifetimeDecisive = lifetimeWins + lifetimeLosses;
    const lifetimeGraded   = lifetimeDecisive + lifetimePushes;

    const items = picked.map(w => _toPublicSuccessCard(w, gameByEvent.get(w.eventId)));

    const perSport = {};
    for (const sport of SUPPORTED_SPORTS) {
      perSport[sport] = (bySport.get(sport) || []).length;
    }

    const result = {
      items,
      total: lifetimeGraded,
      hitRate: lifetimeDecisive > 0
        ? Math.round((lifetimeWins * 100) / lifetimeDecisive)
        : null,
      perSport,
      windowDays: sinceDays,
      lifetime: {
        wins:    lifetimeWins,
        losses:  lifetimeLosses,
        pushes:  lifetimePushes,
        graded:  lifetimeGraded,
        archivedFromOlder: archives.reduce((s, a) => s + (a.insightsArchived || 0), 0),
      },
    };

    await cacheSet(cacheKey, result, TTL_RECENT_SUCCESSES);
    return result;
  }

  /**
   * Public: most recent insights regardless of outcome state.
   *
   * Used by the hero carousel — we want it to show fresh AI work, not just
   * graded winners. Each item is tagged with its current outcome state
   * ('HIT' / 'MISS' / 'PUSH' / null=pending) so the UI can label appropriately.
   *
   * Pulls from all 5 supported sports with a fair-distribution allocator so
   * the carousel doesn't get dominated by whichever sport is most active.
   *
   * @param {Object} opts
   * @param {number} [opts.limit=6]
   * @param {number} [opts.perSportMin=1]
   */
  async getRecentPublicInsights({ limit = 6, perSportMin = 1 } = {}) {
    const cacheKey = `perf:recent-public:v1:${limit}:${perSportMin}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Pull a generous pool — winners first, then anything recent.
    const pool = await Insight.find({
      status: 'generated',
      recommendation: { $in: ['over', 'under'] },
      sport: { $in: SUPPORTED_SPORTS },
    })
      .sort({ createdAt: -1 })
      .limit(120)
      .select('sport eventId playerName statType bettingLine recommendation '
            + 'confidenceScore edgePercentage outcomeActual outcomeResult outcomeGradedAt '
            + 'createdAt insightSummary isHighConfidence isBestValue leagueContext')
      .lean();

    if (!pool.length) {
      const empty = { items: [] };
      await cacheSet(cacheKey, empty, TTL_RECENT_SUCCESSES);
      return empty;
    }

    // Group by sport for fair distribution
    const bySport = new Map();
    for (const i of pool) {
      if (!i.sport) continue;
      if (!bySport.has(i.sport)) bySport.set(i.sport, []);
      bySport.get(i.sport).push(i);
    }

    const picked = _distribute(bySport, limit, perSportMin);

    // Attach game metadata for logos / matchup
    const eventIds = [...new Set(picked.map(i => i.eventId).filter(Boolean))];
    const games    = eventIds.length
      ? await Game.find({ oddsEventId: { $in: eventIds } })
          .select('oddsEventId homeTeam awayTeam startTime').lean()
      : [];
    const gameByEvent = new Map(games.map(g => [g.oddsEventId, g]));

    const items = picked.map(i => _toPublicSuccessCard(i, gameByEvent.get(i.eventId), {}));
    const result = { items };
    await cacheSet(cacheKey, result, TTL_RECENT_SUCCESSES);
    return result;
  }

  /**
   * Lifetime archive snapshot — used by admin page.
   * Returns one entry per sport with running totals.
   */
  async getArchiveSnapshot() {
    const archives = await PerformanceArchive.find({}).lean();
    const bySport = {};
    for (const sport of SUPPORTED_SPORTS) bySport[sport] = {
      sport, wins: 0, losses: 0, pushes: 0, voids: 0,
      insightsArchived: 0, oldestArchivedAt: null, lastArchivedAt: null,
    };
    for (const a of archives) {
      if (bySport[a.sport]) {
        bySport[a.sport] = {
          sport: a.sport,
          wins: a.wins || 0, losses: a.losses || 0,
          pushes: a.pushes || 0, voids: a.voids || 0,
          insightsArchived: a.insightsArchived || 0,
          oldestArchivedAt: a.oldestArchivedAt || null,
          lastArchivedAt:   a.lastArchivedAt || null,
        };
      }
    }
    return bySport;
  }

  /**
   * Per-game accuracy report (admin).
   *
   * Aggregates graded insights by eventId. Returns a paginated list with the
   * insight win/loss/push counts and basic game metadata for each event.
   *
   * @param {Object} opts
   * @param {string} [opts.sport]   — 'all' | 'nba' | 'mlb' | 'nhl'
   * @param {number} [opts.days=30]
   * @param {number} [opts.page=1]
   * @param {number} [opts.limit=20]
   */
  async getPerGameReport({ sport = 'all', days = 30, page = 1, limit = 20 } = {}) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const match = {
      status:        'generated',
      eventId:       { $ne: null },
      outcomeGradedAt: { $gte: since },
      outcomeResult: { $in: ['win', 'loss', 'push', 'void'] },
    };
    if (sport !== 'all') match.sport = sport;

    const aggregate = await Insight.aggregate([
      { $match: match },
      {
        $group: {
          _id:           '$eventId',
          sport:         { $first: '$sport' },
          insights:      { $sum: 1 },
          wins:          { $sum: { $cond: [{ $eq: ['$outcomeResult', 'win'] }, 1, 0] } },
          losses:        { $sum: { $cond: [{ $eq: ['$outcomeResult', 'loss'] }, 1, 0] } },
          pushes:        { $sum: { $cond: [{ $eq: ['$outcomeResult', 'push'] }, 1, 0] } },
          voids:         { $sum: { $cond: [{ $eq: ['$outcomeResult', 'void'] }, 1, 0] } },
          avgConfidence: { $avg: '$confidenceScore' },
          avgEdge:       { $avg: { $abs: '$edgePercentage' } },
          lastGradedAt:  { $max: '$outcomeGradedAt' },
        },
      },
      { $sort: { lastGradedAt: -1 } },
      {
        $facet: {
          rows: [
            { $skip: (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10)) },
            { $limit: Math.max(1, parseInt(limit, 10)) },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const rows  = aggregate[0]?.rows || [];
    const total = aggregate[0]?.total?.[0]?.n || 0;

    // Decorate with game metadata in one batch
    const eventIds = rows.map(r => r._id).filter(Boolean);
    const games    = eventIds.length
      ? await Game.find({ oddsEventId: { $in: eventIds } })
          .select('oddsEventId homeTeam awayTeam startTime status').lean()
      : [];
    const gameByEvent = new Map(games.map(g => [g.oddsEventId, g]));

    const decorated = rows.map(r => {
      const game = gameByEvent.get(r._id);
      const decisive = r.wins + r.losses;
      return {
        eventId:      r._id,
        sport:        r.sport,
        homeTeam:     game?.homeTeam?.name        || null,
        awayTeam:     game?.awayTeam?.name        || null,
        homeAbbr:     game?.homeTeam?.abbreviation || null,
        awayAbbr:     game?.awayTeam?.abbreviation || null,
        startTime:    game?.startTime  || null,
        gameStatus:   game?.status     || null,
        insights:     r.insights,
        wins:         r.wins,
        losses:       r.losses,
        pushes:       r.pushes,
        voids:        r.voids,
        winRate:      decisive > 0 ? Math.round((r.wins * 100) / decisive) : null,
        avgConfidence: r.avgConfidence != null ? Number(r.avgConfidence.toFixed(1)) : null,
        avgEdge:      r.avgEdge != null      ? Number(r.avgEdge.toFixed(1))      : null,
        lastGradedAt: r.lastGradedAt,
      };
    });

    // Aggregate footer for the filtered window
    const totals = decorated.reduce((acc, r) => {
      acc.wins   += r.wins;
      acc.losses += r.losses;
      acc.pushes += r.pushes;
      return acc;
    }, { wins: 0, losses: 0, pushes: 0 });
    const decisiveTotal = totals.wins + totals.losses;

    return {
      rows: decorated,
      pagination: {
        page:  parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / Math.max(1, parseInt(limit, 10))),
      },
      summary: {
        gamesShown: decorated.length,
        wins:    totals.wins,
        losses:  totals.losses,
        pushes:  totals.pushes,
        winRate: decisiveTotal > 0 ? Math.round((totals.wins * 100) / decisiveTotal) : null,
      },
    };
  }

  /**
   * Full insight roster for one game (admin).
   *
   * @param {string} eventId
   */
  async getGameDetail(eventId) {
    if (!eventId) return null;

    const [insights, game] = await Promise.all([
      Insight.find({ eventId, status: 'generated' })
        .sort({ outcomeGradedAt: -1, createdAt: -1 })
        .select('sport playerName statType bettingLine recommendation '
              + 'confidenceScore edgePercentage outcomeResult outcomeActual '
              + 'outcomeGradedAt outcomeReason outcomeGameStatus '
              + 'isHighConfidence isBestValue createdAt insightSummary')
        .lean(),
      Game.findOne({ oddsEventId: eventId })
        .select('oddsEventId sport homeTeam awayTeam startTime status').lean(),
    ]);

    if (!insights.length && !game) return null;

    // Per-game roll-up
    const wins   = insights.filter(i => i.outcomeResult === 'win').length;
    const losses = insights.filter(i => i.outcomeResult === 'loss').length;
    const pushes = insights.filter(i => i.outcomeResult === 'push').length;
    const voids  = insights.filter(i => i.outcomeResult === 'void').length;
    const pending = insights.filter(i =>
      !['win', 'loss', 'push', 'void'].includes(i.outcomeResult)
    ).length;
    const decisive = wins + losses;

    return {
      game: game ? {
        eventId:    game.oddsEventId,
        sport:      game.sport,
        homeTeam:   game.homeTeam?.name        || null,
        awayTeam:   game.awayTeam?.name        || null,
        homeAbbr:   game.homeTeam?.abbreviation || null,
        awayAbbr:   game.awayTeam?.abbreviation || null,
        startTime:  game.startTime,
        status:     game.status,
      } : { eventId, sport: insights[0]?.sport || null },
      summary: {
        insights: insights.length,
        wins, losses, pushes, voids, pending,
        winRate: decisive > 0 ? Math.round((wins * 100) / decisive) : null,
      },
      insights: insights.map(i => ({
        id:           String(i._id),
        sport:        i.sport,
        playerName:   i.playerName,
        statType:     i.statType,
        line:         i.bettingLine,
        recommendation: i.recommendation,
        actual:       num(i.outcomeActual),
        result:       i.outcomeResult || 'pending',
        reason:       i.outcomeReason || null,
        confidence:   num(i.confidenceScore),
        edge:         num(i.edgePercentage),
        isHighConfidence: !!i.isHighConfidence,
        isBestValue:      !!i.isBestValue,
        gameStatus:   i.outcomeGameStatus || null,
        gradedAt:     i.outcomeGradedAt || null,
        createdAt:    i.createdAt,
        summary:      i.insightSummary || null,
      })),
    };
  }

  /**
   * Lifecycle: rolling-window deletion of GRADED insights.
   *
   * Insights older than `days` (default 90) are aggregated by sport into
   * the PerformanceArchive collection (lifetime counters), then deleted.
   * This keeps the Insight collection bounded — at steady state it holds
   * roughly N days × insights_per_day worth of docs, while public hit-rate
   * still reflects all-time accuracy because the archive is blended in.
   *
   * Atomic per-sport: each sport runs in its own pass so a partial failure
   * doesn't corrupt the archive.
   *
   * @param {Object} opts
   * @param {number} [opts.days]   — retention window in days (default 90)
   * @param {boolean}[opts.dryRun] — count what would be deleted without deleting
   */
  async archiveAndPruneGraded({ days = GRADED_RETENTION_DAYS, dryRun = false } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const totals = { archived: 0, deleted: 0, perSport: {} };

    for (const sport of SUPPORTED_SPORTS) {
      // Aggregate counts from the to-be-pruned cohort
      const agg = await Insight.aggregate([
        {
          $match: {
            sport,
            status: 'generated',
            outcomeResult:   { $in: ['win', 'loss', 'push', 'void'] },
            outcomeGradedAt: { $lt: cutoff, $ne: null },
          },
        },
        {
          $group: {
            _id: null,
            wins:    { $sum: { $cond: [{ $eq: ['$outcomeResult', 'win']  }, 1, 0] } },
            losses:  { $sum: { $cond: [{ $eq: ['$outcomeResult', 'loss'] }, 1, 0] } },
            pushes:  { $sum: { $cond: [{ $eq: ['$outcomeResult', 'push'] }, 1, 0] } },
            voids:   { $sum: { $cond: [{ $eq: ['$outcomeResult', 'void'] }, 1, 0] } },
            count:   { $sum: 1 },
            sumWinEdge:  { $sum: { $cond: [{ $eq: ['$outcomeResult', 'win']  }, { $abs: { $ifNull: ['$edgePercentage', 0] } }, 0] } },
            sumLossEdge: { $sum: { $cond: [{ $eq: ['$outcomeResult', 'loss'] }, { $abs: { $ifNull: ['$edgePercentage', 0] } }, 0] } },
            oldestGradedAt: { $min: '$outcomeGradedAt' },
          },
        },
      ]);

      const stats = agg[0];
      totals.perSport[sport] = {
        archived: stats?.count || 0,
        wins:     stats?.wins   || 0,
        losses:   stats?.losses || 0,
        pushes:   stats?.pushes || 0,
        voids:    stats?.voids  || 0,
      };
      if (!stats || stats.count === 0) continue;

      if (!dryRun) {
        // Increment archive counters atomically
        await PerformanceArchive.findOneAndUpdate(
          { sport },
          {
            $inc: {
              wins:               stats.wins,
              losses:             stats.losses,
              pushes:             stats.pushes,
              voids:              stats.voids,
              insightsArchived:   stats.count,
              sumAbsEdgeOnWins:   stats.sumWinEdge   || 0,
              sumAbsEdgeOnLosses: stats.sumLossEdge  || 0,
            },
            $set: { lastArchivedAt: new Date() },
            $min: { oldestArchivedAt: stats.oldestGradedAt },
          },
          { upsert: true, new: true }
        );

        // Delete the original Insight docs
        const del = await Insight.deleteMany({
          sport,
          status: 'generated',
          outcomeResult:   { $in: ['win', 'loss', 'push', 'void'] },
          outcomeGradedAt: { $lt: cutoff, $ne: null },
        });
        totals.deleted += del.deletedCount || 0;
        totals.archived += stats.count;

        logger.info(`[PerformanceService] Archived+pruned ${sport}: ${stats.count} graded insights >${days}d (W=${stats.wins} L=${stats.losses} P=${stats.pushes})`);
      } else {
        totals.archived += stats.count;
      }
    }

    return { ...totals, days, dryRun };
  }

  /**
   * Lifecycle: prune insights that have been retried-to-exhaustion and have
   * no chance of being graded (e.g., player not found, game vanished). Keeps
   * the index lean without touching real graded outcomes.
   *
   * Runs from the daily admin cron. Safe to call any time.
   */
  async pruneExhaustedRetries({ days = RETRY_EXHAUSTED_PRUNE_DAYS } = {}) {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const result = await Insight.deleteMany({
      status: 'generated',
      outcomeResult: { $in: ['unresolved', null, 'void'] },
      outcomeReason: { $in: ['retry_exhausted', 'void_retry_exhausted', 'player_not_found', 'unsupported_sport'] },
      createdAt: { $lt: cutoff },
    });
    if (result.deletedCount > 0) {
      logger.info(`[PerformanceService] Pruned ${result.deletedCount} exhausted-retry insights older than ${days}d`);
    }
    return { deleted: result.deletedCount || 0 };
  }
}

module.exports = new PerformanceService();
module.exports.SUPPORTED_SPORTS = SUPPORTED_SPORTS;

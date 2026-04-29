/**
 * InsightOutcomeService.js — Grade AI predictions vs actual game results
 *
 * ARCHITECTURE (matches real file, fixes applied):
 *  - Class-based singleton
 *  - persistOutcomesForEvents(eventIds[]) — takes eventIds array
 *  - Grades by fetching player game log and matching the game date
 *  - getOutcomeSummary({ sinceDays, limit, includeSamples }) for admin dashboard
 *
 * FIXES IN THIS VERSION:
 *
 *  FIX 1 — NBA 'points_assists' missing from extractStat()
 *    'points_assists' was not in the NBA stat map → extractStat returned null
 *    → every points_assists insight stayed 'unresolved'.
 *    Added: points_assists: ['points_assists', 'pts+ast'] with computation fallback.
 *
 *  FIX 2 — NBA grading failed when props were deleted
 *    Root cause: _getStatsForInsight builds propIdByKey from PlayerProp documents.
 *    But postGameSync._deleteStaleData() deletes props 6h after game start.
 *    When the re-grade loop runs after deletion, propId lookup → null → empty stats.
 *    Fix: Falls back to PlayerCache (permanent, never deleted) when PlayerProp lookup fails.
 *    PlayerCache stores apiSportsPlayerId by playerName+sport — survives prop deletion.
 *
 *  FIX 3 — Date matching tolerance too strict
 *    parseDateFromRow finds the game log row closest in time to game.startTime.
 *    If the game log row's date has a timezone offset, the diff could be >24h
 *    even for the correct game. Added a 48h tolerance window.
 *
 *  FIX 4 — points_assists extractStat field mapping
 *    API-Sports NBA v2 game log doesn't have a 'points_assists' field.
 *    It has 'points' and 'assists' separately (FLAT, not nested).
 *    extractStat now computes points + assists for this stat type.
 */

const Insight      = require('../models/Insight.model');
const { Game }     = require('../models/Game.model');
const PlayerProp   = require('../models/PlayerProp.model');
const { getAdapter } = require('./adapters/adapterRegistry');
const { PlayerCache } = require('../utils/playerResolver');
const logger       = require('../config/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDateFromRow(row) {
  const candidates = [
    row.gameDate, row.date, row.game_date, row.startTime,
    row.game?.date?.start, row.game?.datetime,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (sport === 'nhl') {
    // points = goals + assists (no direct field)
    if (statType === 'points') {
      const g = toNum(row.goals);
      const a = toNum(row.assists);
      if (Number.isFinite(g) && Number.isFinite(a)) return g + a;
      return null;
    }
    const map = {
      goals:         ['goals'],
      assists:        ['assists'],
      shots_on_goal:  ['shots', 'shotsOnGoal', 'sog'],
    };
    for (const key of map[statType] || [statType]) {
      const value = toNum(row[key]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

function extractStat(row, statType, sport) {
  const toNum = (value) =>
    value === null || value === undefined || value === '' ? null : Number(value);

  if (sport === 'nba') {
    // FIX 4: points_assists = points + assists (both are flat fields in API-Sports v2)
    if (statType === 'points_assists') {
      const pts = toNum(row.points);
      const ast = toNum(row.assists);
      if (Number.isFinite(pts) && Number.isFinite(ast)) return pts + ast;
      if (Number.isFinite(pts)) return pts;
      return null;
    }

    const map = {
      points:   ['points', 'pts'],
      rebounds: ['rebounds', 'reb', 'totReb', 'trb'],
      assists:  ['assists', 'ast'],
      threes:   ['threes', 'threePointersMade', 'tpm', 'fg3m', 'three_pointers_made'],
    };

    for (const key of map[statType] || [statType]) {
      const value = toNum(row[key]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  if (sport === 'mlb') {
    const map = {
      hits:                 ['hits', 'h'],
      total_bases:          ['totalBases', 'total_bases', 'tb'],
      runs:                 ['runs', 'r'],
      rbis:                 ['rbis', 'rbi'],
      pitcher_strikeouts:   ['strikeOuts', 'pitcherStrikeouts', 'strikeouts', 'so', 'k'],
    };

    for (const key of map[statType] || [statType]) {
      const value = toNum(row[key]);
      if (Number.isFinite(value)) return value;
    }
  }

  if (sport === 'nhl') {
    // points = goals + assists (no direct field)
    if (statType === 'points') {
      const g = toNum(row.goals);
      const a = toNum(row.assists);
      if (Number.isFinite(g) && Number.isFinite(a)) return g + a;
      return null;
    }
    const map = {
      goals:         ['goals'],
      assists:        ['assists'],
      shots_on_goal:  ['shots', 'shotsOnGoal', 'sog'],
    };
    for (const key of map[statType] || [statType]) {
      const value = toNum(row[key]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

function buildBandSummary(rows, label) {
  const wins   = rows.filter(r => r.result === 'win').length;
  const losses = rows.filter(r => r.result === 'loss').length;
  const pushes = rows.filter(r => r.result === 'push').length;
  return {
    label,
    graded:       rows.length,
    wins, losses, pushes,
    winRateExPush: (wins + losses)
      ? Number((wins * 100 / (wins + losses)).toFixed(2))
      : null,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

class InsightOutcomeService {

  async persistOutcomesForEvents(eventIds = []) {
    const uniqueIds = [...new Set((eventIds || []).filter(Boolean))];
    if (!uniqueIds.length) return { processed: 0, updated: 0, unresolved: 0 };

    const insights = await Insight.find({
      eventId:        { $in: uniqueIds },
      status:         'generated',
      recommendation: { $in: ['over', 'under'] },
      outcomeResult:  { $nin: ['win', 'loss', 'push', 'void'] },
    })
      .select('sport eventId playerName statType bettingLine recommendation confidenceScore edgePercentage createdAt')
      .lean();

    if (!insights.length) return { processed: 0, updated: 0, unresolved: 0 };

    const rows       = await this._gradeInsights(insights);
    const gradedAt   = new Date();

    const operations = rows.map(row => ({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            outcomeResult:     row.result,
            outcomeActual:     row.actual,
            outcomeGameStatus: row.gameStatus || null,
            outcomeGradedAt:   gradedAt,
          },
        },
      },
    }));

    if (!operations.length) return { processed: insights.length, updated: 0, unresolved: 0 };

    const result = await Insight.bulkWrite(operations, { ordered: false });
    return {
      processed:   insights.length,
      updated:     result.modifiedCount || result.nModified || 0,
      unresolved:  rows.filter(r => r.result === 'unresolved').length,
    };
  }

  async getOutcomeSummary({ sinceDays = 14, limit = 150, includeSamples = false } = {}) {
    const now = new Date();
    const startedStatuses = new Set(['live', 'inplay', 'final', 'finished', 'completed', 'closed']);
    const resolvedResults = new Set(['win', 'loss', 'push', 'void']);

    const insights = await Insight.find({
      status:         'generated',
      recommendation: { $in: ['over', 'under'] },
      createdAt:      { $gte: new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000) },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('sport eventId playerName statType bettingLine recommendation confidenceScore edgePercentage createdAt outcomeResult outcomeActual outcomeGameStatus outcomeGradedAt')
      .lean();

    const eventIds  = [...new Set(insights.map(i => i.eventId).filter(Boolean))];
    const games     = await Game.find({ oddsEventId: { $in: eventIds } })
      .select('oddsEventId startTime status').lean();
    const gameByEvent = new Map(games.map(g => [g.oddsEventId, g]));

    const started = insights.filter(insight => {
      const game        = gameByEvent.get(insight.eventId);
      const gameStarted = Boolean(game?.startTime && new Date(game.startTime) <= now);
      const outcomeStatus = String(insight.outcomeGameStatus || '').toLowerCase();
      const gameMissingButResolved = !game && resolvedResults.has(String(insight.outcomeResult || '').toLowerCase());
      return gameStarted || startedStatuses.has(outcomeStatus) || gameMissingButResolved;
    });

    const rows = started.map(insight => {
      const game = gameByEvent.get(insight.eventId);
      return {
        ...insight,
        gameStatus: insight.outcomeGameStatus || game?.status || null,
        actual:     insight.outcomeActual,
        result:     insight.outcomeResult || 'pending',
      };
    });

    const resolved = rows.filter(r => ['win', 'loss', 'push'].includes(r.result));
    const wins     = resolved.filter(r => r.result === 'win').length;
    const losses   = resolved.filter(r => r.result === 'loss').length;
    const pushes   = resolved.filter(r => r.result === 'push').length;

    const winRows  = resolved.filter(r => r.result === 'win');
    const lossRows = resolved.filter(r => r.result === 'loss');
    const avgEdge  = (arr) => {
      const valid = arr.map(r => r.edgePercentage).filter(v => Number.isFinite(v));
      return valid.length
        ? Number((valid.reduce((s, v) => s + Math.abs(v), 0) / valid.length).toFixed(2))
        : null;
    };

    const bySportRows = ['nba', 'mlb'].map(sport =>
      buildBandSummary(resolved.filter(r => r.sport === sport), sport)
    );

    const byConfidenceRows = [
      { label: '80-100', min: 80,  max: 100    },
      { label: '60-79',  min: 60,  max: 79.9999 },
      { label: '0-59',   min: 0,   max: 59.9999 },
    ].map(band => buildBandSummary(
      resolved.filter(r => {
        const score = r.confidenceScore ?? 0;
        return score >= band.min && score <= band.max;
      }),
      band.label
    ));

    const summary = {
      scannedInsights:  insights.length,
      startedInsights:  started.length,
      graded:           resolved.length,
      unresolved:       rows.filter(r => ['unresolved', 'pending'].includes(r.result)).length,
      wins, losses, pushes,
      winRateExPush:    (wins + losses)
        ? Number((wins * 100 / (wins + losses)).toFixed(2))
        : null,
      avgEdgeOnWins:    avgEdge(winRows),
      avgEdgeOnLosses:  avgEdge(lossRows),
      byResult:         { win: wins, loss: losses, push: pushes },
      bySport:          Object.fromEntries(bySportRows.map(r  => [r.label, r])),
      byConfidence:     Object.fromEntries(byConfidenceRows.map(r => [r.label, r])),
    };

    if (includeSamples) {
      const mapRow = r => ({
        sport:      r.sport,
        eventId:    r.eventId,
        playerName: r.playerName,
        statType:   r.statType,
        createdAt:  r.createdAt,
        rec:        r.recommendation,
        line:       r.bettingLine,
        actual:     r.actual,
        result:     r.result,
        confidence: r.confidenceScore,
        edge:       r.edgePercentage,
        gameStatus: r.gameStatus,
      });
      summary.sampleResolved   = resolved.slice(0, 20).map(mapRow);
      summary.sampleUnresolved = rows.filter(r => r.result === 'unresolved').slice(0, 20).map(mapRow);
      summary.samplePending    = rows.filter(r => r.result === 'pending').slice(0, 20).map(mapRow);
    }

    return summary;
  }

  // ─── Grade insights against game log stats ─────────────────────────────────

  async _gradeInsights(insights) {
    const eventIds = [...new Set(insights.map(i => i.eventId).filter(Boolean))];

    const games = await Game.find({ oddsEventId: { $in: eventIds } })
      .select('oddsEventId startTime status').lean();
    const gameByEvent = new Map(games.map(g => [g.oddsEventId, g]));

    // FIX 2: Build player ID lookup from BOTH PlayerProp AND PlayerCache
    // PlayerProp may be deleted after 6h; PlayerCache is permanent
    const nbaInsights = insights.filter(i => i.sport === 'nba');

    // First: try PlayerProp (faster, more specific)
    const props = nbaInsights.length
      ? await PlayerProp.find({
          oddsEventId: { $in: [...new Set(nbaInsights.map(i => i.eventId))] },
          playerName:  { $in: [...new Set(nbaInsights.map(i => i.playerName))] },
        }).select('oddsEventId playerName statType apiSportsPlayerId').lean()
      : [];

    const propIdByKey = new Map(
      props.map(p => [`${p.oddsEventId}::${p.playerName}::${p.statType}`, p.apiSportsPlayerId])
    );

    // Second: build PlayerCache fallback — keyed by normalized playerName
    const uniqueNBANames = [...new Set(nbaInsights.map(i => i.playerName).filter(Boolean))];
    const cacheEntries   = uniqueNBANames.length
      ? await PlayerCache.find({
          sport:       'nba',
          oddsApiName: { $in: uniqueNBANames.map(n => n.toLowerCase().replace(/['.]/g, '').trim()) },
        }).lean()
      : [];

    const playerCacheById = new Map(
      cacheEntries.map(e => [e.oddsApiName, e.apiSportsId])
    );

    const statsCache = new Map();
    const rows       = [];

    for (const insight of insights) {
      const game = gameByEvent.get(insight.eventId);
      if (!game) continue;

      const stats       = await this._getStatsForInsight(insight, propIdByKey, playerCacheById, statsCache);
      const targetDate  = new Date(game.startTime);
      let bestRow       = null;
      let bestDiff      = Infinity;

      for (const row of stats) {
        const parsedDate = parseDateFromRow(row);
        if (!parsedDate) continue;
        const diff = Math.abs(parsedDate.getTime() - targetDate.getTime());
        // FIX 3: 48h tolerance (timezone differences can shift by up to ~24h)
        if (diff < bestDiff && diff < 48 * 60 * 60 * 1000) {
          bestDiff = diff;
          bestRow  = row;
        }
      }

      const actual = bestRow ? extractStat(bestRow, insight.statType, insight.sport) : null;

      if (!Number.isFinite(actual)) {
        rows.push({ ...insight, gameStatus: game.status, result: 'unresolved', actual: null });
        logger.debug('[OutcomeService] No stat found', {
          playerName: insight.playerName, statType: insight.statType,
          statsCount: stats.length, bestRowFound: !!bestRow,
        });
        continue;
      }

      const push = actual === insight.bettingLine;
      const won  = insight.recommendation === 'over'
        ? actual > insight.bettingLine
        : actual < insight.bettingLine;

      rows.push({
        ...insight,
        gameStatus: game.status,
        actual,
        result: push ? 'push' : (won ? 'win' : 'loss'),
      });
    }

    return rows;
  }

  async _getStatsForInsight(insight, propIdByKey, playerCacheById, statsCache) {
    const adapter = getAdapter(insight.sport);

    if (insight.sport === 'mlb') {
      const cacheKey = `mlb::${insight.playerName}::${insight.statType === 'pitcher_strikeouts' ? 'pitcher' : 'batter'}`;
      if (!statsCache.has(cacheKey)) {
        statsCache.set(cacheKey, await adapter.fetchPlayerStats({
          playerName: insight.playerName,
          isPitcher:  insight.statType === 'pitcher_strikeouts',
        }) || []);
      }
      return statsCache.get(cacheKey);
    }

    if (insight.sport === 'nba') {
      // FIX 2: Try PlayerProp first, then PlayerCache fallback
      let playerId = propIdByKey.get(
        `${insight.eventId}::${insight.playerName}::${insight.statType}`
      );

      if (!playerId) {
        // Prop may have been deleted — fall back to PlayerCache
        const normName = (insight.playerName || '')
          .toLowerCase().replace(/['.]/g, '').trim();
        playerId = playerCacheById.get(normName) || null;

        if (playerId) {
          logger.debug('[OutcomeService] Used PlayerCache fallback for', {
            playerName: insight.playerName, playerId,
          });
        }
      }

      if (!playerId) {
        logger.warn('[OutcomeService] No player ID found for NBA insight', {
          playerName: insight.playerName, statType: insight.statType,
        });
        return [];
      }

      const cacheKey = `nba::${playerId}`;
      if (!statsCache.has(cacheKey)) {
        statsCache.set(cacheKey, await adapter.fetchPlayerStats({ playerId }) || []);
      }
      return statsCache.get(cacheKey);
    }

    if (insight.sport === 'nhl') {
      const cacheKey = `nhl::${insight.playerName}`;
      if (!statsCache.has(cacheKey)) {
        statsCache.set(cacheKey, await adapter.fetchPlayerStats({
          playerName: insight.playerName,
        }) || []);
      }
      return statsCache.get(cacheKey);
    }

    return [];
  }
}

module.exports = new InsightOutcomeService();
/**
 * StrategyService.js — Prop scoring engine
 *
 * Runs after every PropWatcher cycle. Outputs confidence scores and edge
 * percentages stored directly on each PlayerProp document in MongoDB.
 *
 * DATA SOURCES:
 *  NBA → API-Sports NBA v2 game logs (requires apiSportsPlayerId on prop)
 *  MLB → Official MLB Stats API (statsapi.mlb.com, lookup by playerName)
 *  NHL → Official NHL Stats API (api-web.nhle.com, lookup by player/team names)
 *
 * CONFIDENCE FORMULA (game log available):
 *  Weighted hit rate over the form window (last 5-8 games).
 *  Margins are LINE-SCALED so small lines (e.g. 0.5 hits) score fairly:
 *    strongMargin = min(2.0, line)       → for 0.5 line: 0.5 unit = strong
 *    normalMargin = min(0.5, line × 0.5) → for 0.5 line: 0.25 unit = normal
 *  Hit weights:  >= strongMargin → 1.4 | >= normalMargin → 1.0 | > 0 → 0.7 | miss → 0
 *  Score = sum(weights) / (n × 1.4) × 100, capped at 100
 *
 * CONFIDENCE FALLBACK (no game log):
 *  Estimated from edge magnitude:
 *  |edge| >= 20% → 80 | >= 12% → 65 | >= 6% → 50 | < 6% → 30
 *
 * EDGE FORMULA:
 *  (focusStatAvg - line) / line × 100
 *  Positive → OVER signal | Negative → UNDER signal
 *
 * TAGS:
 *  isHighConfidence = confidenceScore >= 57
 *  isBestValue      = |edgePercentage| >= MIN_EDGE_PERCENTAGE (15%)
 */

const PlayerProp = require('../models/PlayerProp.model');
const { getAdapter } = require('./shared/adapterRegistry');
const PlayerStatsSnapshotService = require('./PlayerStatsSnapshotService');
const { getLeagueProfile, getMinEdgeForStat, getMinGamesForStat } = require('../config/leagueProfiles');
const logger = require('../config/logger');

const HC_THRESHOLD = 57;
const SCORE_BULK_BATCH_SIZE = Math.max(100, parseInt(process.env.SCORE_BULK_BATCH_SIZE || '300', 10));

class StrategyService {

  // ─── Score a single prop ───────────────────────────────────────────────────

  async scoreProp(prop, stats) {
    try {
      const adapter        = getAdapter(prop.sport);
      const processedStats = adapter.applyFormulas(
        stats,
        prop.statType,
        { isPitcher: prop.isPitcher || prop.statType === 'pitcher_strikeouts' }
      );
      const scores = this._computeScores(processedStats, prop.line, { sport: prop.sport, statType: prop.statType });
      await PlayerProp.findByIdAndUpdate(prop._id, { ...scores, lastScoredAt: new Date() });

      logger.debug('✅ [StrategyService] Scored', {
        playerName: prop.playerName,
        statType:   prop.statType,
        line:       prop.line,
        ...scores,
      });

      return scores;
    } catch (err) {
      logger.error('❌ [StrategyService] scoreProp failed', {
        propId:     prop._id,
        playerName: prop.playerName,
        error:      err.message,
      });
      return null;
    }
  }

  // ─── Score all props for a sport ──────────────────────────────────────────

  async scoreAllPropsForSport(sport, { eventIds = null } = {}) {
    logger.info(`📊 [StrategyService] Scoring all props for ${sport}...`);

    const uniqueEventIds = Array.isArray(eventIds)
      ? [...new Set(eventIds.filter(Boolean).map(String))]
      : [];

    const query = {
      sport,
      isAvailable: true,
      $or: [
        { lastScoredAt: { $exists: false } },
        { lastScoredAt: null },
        { $expr: { $gt: ['$lastUpdatedAt', '$lastScoredAt'] } },
      ],
    };

    if (uniqueEventIds.length) {
      query.oddsEventId = { $in: uniqueEventIds };
    }

    const props = await PlayerProp.find(query)
      .populate('gameId', 'league leagueId leagueRegion')
      .lean();

    logger.info(`📊 [StrategyService] Found ${props.length} changed props to score for ${sport}`, {
      eventCount: uniqueEventIds.length || undefined,
    });
    if (!props.length) return { scored: 0, failed: 0, noStats: 0 };

    const now = new Date();
    const adapter = getAdapter(sport);
    const groupedFetches = new Map();
    const updateOps = [];

    let scored          = 0;
    let failed          = 0;
    let noStats         = 0;
    let hcTagged        = 0;   // props that ended up isHighConfidence: true
    let bvTagged        = 0;   // props that ended up isBestValue: true
    let hiddenInsufficientGames = 0;
    let hiddenNoStats           = 0;

    for (const prop of props) {
      const spec = this._buildStatsFetchSpec(sport, prop);
      if (!spec) {
        const noStatsUpdate = this._buildNoStatsUpdate(prop, now);
        updateOps.push(noStatsUpdate);
        noStats++;
        // If the noStats path resolved to a hide (no fallback avg → isAvailable:false)
        // that's user-visible — count it separately so the admin can see the reason.
        if (noStatsUpdate?.updateOne?.update?.$set?.isAvailable === false) {
          hiddenNoStats++;
        }
        continue;
      }

      const group = groupedFetches.get(spec.key);
      if (group) {
        group.props.push(prop);
      } else {
        groupedFetches.set(spec.key, {
          fetchParams: spec.fetchParams,
          props: [prop],
          stats: null,
        });
      }
    }

    await Promise.all(
      Array.from(groupedFetches.values()).map(async (group) => {
        try {
          group.stats = await PlayerStatsSnapshotService.getPlayerStats({
            sport,
            ...group.fetchParams,
          }) || [];
        } catch (err) {
          group.stats = [];
          logger.warn('[StrategyService] Stats fetch group failed', {
            sport,
            fetchParams: group.fetchParams,
            error: err.message,
          });
        }
      })
    );

    for (const group of groupedFetches.values()) {
      const stats = group.stats;
      for (const prop of group.props) {
        try {
          if (!stats?.length) {
            const noStatsUpdate = this._buildNoStatsUpdate(prop, now);
            updateOps.push(noStatsUpdate);
            noStats++;
            if (noStatsUpdate?.updateOne?.update?.$set?.isAvailable === false) {
              hiddenNoStats++;
            }
            continue;
          }

          const minGames = getMinGamesForStat(sport, prop.statType);
          if (stats.length < minGames) {
            updateOps.push({
              updateOne: {
                filter: { _id: prop._id },
                update: { $set: { isAvailable: false, lastScoredAt: now } },
              },
            });
            hiddenInsufficientGames++;
            logger.info(`[StrategyService] Hidden — only ${stats.length} games (need ${minGames})`, {
              playerName: prop.playerName,
            });
            continue;
          }

          const processedStats = adapter.applyFormulas(
            stats,
            prop.statType,
            { isPitcher: prop.isPitcher || prop.statType === 'pitcher_strikeouts' }
          );
          const scores = this._computeScores(processedStats, prop.line, {
            sport: prop.sport,
            statType: prop.statType,
          });

          if (scores?.isHighConfidence) hcTagged++;
          if (scores?.isBestValue)      bvTagged++;

          updateOps.push({
            updateOne: {
              filter: { _id: prop._id },
              update: { $set: { ...scores, lastScoredAt: now } },
            },
          });
          scored++;
        } catch (err) {
          failed++;
          logger.error('[StrategyService] Failed to score prop', {
            playerName: prop.playerName,
            statType: prop.statType,
            error: err.message,
          });
        }
      }
    }

    await this._flushBulkOps(updateOps);

    const summary = {
      scored,
      failed,
      noStats,
      hcTagged,
      bvTagged,
      hiddenInsufficientGames,
      hiddenNoStats,
      totalConsidered: props.length,
    };
    logger.info(`✅ [StrategyService] Scoring complete for ${sport}`, summary);
    return summary;
  }

  _buildStatsFetchSpec(sport, prop) {
    if (sport === 'mlb') {
      const isPitcher = prop.isPitcher || prop.statType === 'pitcher_strikeouts';
      return {
        key: `mlb:${prop.playerName}:${isPitcher ? 'pitcher' : 'batter'}`,
        fetchParams: { playerName: prop.playerName, isPitcher },
      };
    }

    if (sport === 'nhl') {
      return {
        key: `nhl:${prop.playerName}:${prop.homeTeamName || ''}:${prop.awayTeamName || ''}`,
        fetchParams: {
          playerName: prop.playerName,
          homeTeamName: prop.homeTeamName,
          awayTeamName: prop.awayTeamName,
        },
      };
    }

    if (sport === 'soccer') {
      return {
        key: `soccer:${prop.playerName}:${prop.homeTeamName || ''}:${prop.awayTeamName || ''}:${prop.gameId?.leagueId || 'na'}`,
        fetchParams: {
          playerName: prop.playerName,
          homeTeamName: prop.homeTeamName,
          awayTeamName: prop.awayTeamName,
          leagueId: prop.gameId?.leagueId,
        },
      };
    }

    if (prop.apiSportsPlayerId) {
      return {
        key: `${sport}:id:${prop.apiSportsPlayerId}`,
        fetchParams: { playerId: prop.apiSportsPlayerId },
      };
    }

    return null;
  }

  _buildNoStatsUpdate(prop, now) {
    const fallbackAvg = prop.aiPredictedValue ?? prop.focusStatAvg ?? null;
    const edgeScores = this._computeEdgeOnlyScores(prop.line, fallbackAvg, {
      sport: prop.sport,
      statType: prop.statType,
    });

    if (edgeScores) {
      return {
        updateOne: {
          filter: { _id: prop._id },
          update: { $set: { ...edgeScores, lastScoredAt: now } },
        },
      };
    }

    logger.debug('[StrategyService] Hidden — no stats, no fallback signal', {
      playerName: prop.playerName,
      statType: prop.statType,
    });

    return {
      updateOne: {
        filter: { _id: prop._id },
        update: { $set: { isAvailable: false, lastScoredAt: now } },
      },
    };
  }

  async _flushBulkOps(ops) {
    if (!ops.length) return;

    for (let i = 0; i < ops.length; i += SCORE_BULK_BATCH_SIZE) {
      const chunk = ops.slice(i, i + SCORE_BULK_BATCH_SIZE);
      await PlayerProp.bulkWrite(chunk, { ordered: false });
    }
  }

  // ─── Score computation (public so InsightService can call it) ─────────────

  /**
   * Compute all scores from processedStats + bettingLine.
   * Called by both scoreProp() and InsightService._calculateStrategyScores().
   *
   * @param {Object} processedStats - Output of adapter.applyFormulas()
   * @param {number} bettingLine
   * @returns {{ confidenceScore, edgePercentage, aiPredictedValue, isHighConfidence, isBestValue }}
   */
  computeScores(processedStats, bettingLine, context = {}) {
    return this._computeScores(processedStats, bettingLine, context);
  }

  _computeScores(processedStats, bettingLine, context = {}) {
    const profile = getLeagueProfile(context?.sport);
    const scoring = profile?.scoring || {};
    const confidenceCfg = scoring.confidence || {};
    const highConfidenceThreshold = Number.isFinite(scoring.highConfidenceThreshold)
      ? scoring.highConfidenceThreshold
      : HC_THRESHOLD;

    // ── Input hardening ────────────────────────────────────────────────
    // Filter recentStatValues to real numbers so a bad row upstream
    // (undefined, null, NaN, string) can't corrupt mean/variance.
    const rawRecent = Array.isArray(processedStats?.recentStatValues)
      ? processedStats.recentStatValues
      : [];
    const recentStatValues = rawRecent.filter((v) => Number.isFinite(v));

    const parsedFocus = parseFloat(processedStats?.focusStatAvg);
    const hasFocusAvg = Number.isFinite(parsedFocus);
    const focusAvgNum = hasFocusAvg ? parsedFocus : 0;

    const parsedBaseline = parseFloat(processedStats?.baselineGamesCount);
    const baselineGamesCount = Number.isFinite(parsedBaseline) ? parsedBaseline : 30;

    const parsedLine = parseFloat(bettingLine);
    const safeLine   = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : 0;

    // ── Edge percentage ────────────────────────────────────────────────
    // Edge is only meaningful when we have both a positive line AND a valid
    // focus average. Otherwise edge = 0 so downstream flags don't misfire.
    const rawEdge = (safeLine > 0 && hasFocusAvg)
      ? ((focusAvgNum - safeLine) / safeLine) * 100
      : 0;
    const edgePercentage = Number.isFinite(rawEdge) ? parseFloat(rawEdge.toFixed(2)) : 0;
    const absEdge        = Math.abs(edgePercentage);

    // ── Confidence: sport-aware guards ─────────────────────────────────
    // The DEFAULT variance guard is calibrated for consistent-log sports
    // (NBA/NFL passing yards). MLB / NHL / Soccer override with looser
    // tolerances via leagueProfile.scoring.varianceGuard. See leagueProfiles.js
    // for the per-sport rationale.
    const caps = this._resolveVarianceCaps(scoring.varianceGuard);

    let confidenceScore;
    if (recentStatValues.length > 0) {
      const direction    = focusAvgNum >= safeLine ? 'over' : 'under';
      const total        = recentStatValues.length;
      const maxWeight    = Number.isFinite(confidenceCfg.maxWeight)    ? confidenceCfg.maxWeight    : 1.4;
      const strongWeight = Number.isFinite(confidenceCfg.strongWeight) ? confidenceCfg.strongWeight : 1.4;
      const normalWeight = Number.isFinite(confidenceCfg.normalWeight) ? confidenceCfg.normalWeight : 1.0;
      const weakWeight   = Number.isFinite(confidenceCfg.weakWeight)   ? confidenceCfg.weakWeight   : 0.7;
      const strongMarginCap = Number.isFinite(confidenceCfg.strongMarginCap) ? confidenceCfg.strongMarginCap : 2.0;
      const normalMarginCap = Number.isFinite(confidenceCfg.normalMarginCap) ? confidenceCfg.normalMarginCap : 0.5;
      const normalMarginLineFactor = Number.isFinite(confidenceCfg.normalMarginLineFactor)
        ? confidenceCfg.normalMarginLineFactor
        : 0.5;

      // Line-scaled margins — sport-specific caps come from league profiles.
      const strongMargin = Math.min(strongMarginCap, safeLine);
      const normalMargin = Math.min(normalMarginCap, safeLine * normalMarginLineFactor);
      const weightedHits = recentStatValues.reduce((sum, val) => {
        const margin = direction === 'over' ? val - safeLine : safeLine - val;
        if (margin <= 0) return sum;
        return sum + (margin >= strongMargin ? strongWeight : margin >= normalMargin ? normalWeight : weakWeight);
      }, 0);

      const stats = this._computeVarianceStats(recentStatValues);
      const denom = total * maxWeight;
      let baseConfidence = denom > 0
        ? Math.min(99, Math.max(0, Math.round((weightedHits / denom) * 100)))
        : 0;

      baseConfidence = this._applyConfidenceCaps(baseConfidence, {
        hasZeroValue:       stats.hasZeroValue,
        cv:                 stats.cv,
        absEdge,
        baselineGamesCount,
        caps,
      });
      confidenceScore = baseConfidence;
    } else {
      // No recent log — fall back to pure edge-tier confidence, but still
      // apply the sport-agnostic edge caps so a zero-edge prop can't be HC.
      let base = this._edgeToConfidence(absEdge, context);
      base = this._applyEdgeOnlyCaps(base, absEdge);
      confidenceScore = base;
    }

    return {
      confidenceScore,
      edgePercentage,
      aiPredictedValue: hasFocusAvg ? focusAvgNum : null,
      // Guardrail: weak edge (<5%) cannot be HC, even with high confidence score
      isHighConfidence:  confidenceScore >= highConfidenceThreshold && Math.abs(edgePercentage) >= 5,
      isBestValue:       absEdge >= getMinEdgeForStat(context?.sport, context?.statType),
    };
  }

  _computeEdgeOnlyScores(bettingLine, focusStatAvg, context = {}) {
    const profile = getLeagueProfile(context?.sport);
    const scoring = profile?.scoring || {};
    const highConfidenceThreshold = Number.isFinite(scoring.highConfidenceThreshold)
      ? scoring.highConfidenceThreshold
      : HC_THRESHOLD;

    const avg = parseFloat(focusStatAvg);
    const parsedLine = parseFloat(bettingLine);
    if (!Number.isFinite(avg) || !Number.isFinite(parsedLine) || parsedLine <= 0) return null;

    const rawEdge        = ((avg - parsedLine) / parsedLine) * 100;
    const edgePercentage = Number.isFinite(rawEdge) ? parseFloat(rawEdge.toFixed(2)) : 0;
    const absEdge        = Math.abs(edgePercentage);
    let confidenceScore = this._edgeToConfidence(absEdge, context);
    confidenceScore = this._applyEdgeOnlyCaps(confidenceScore, absEdge);

    return {
      edgePercentage,
      confidenceScore,
      // Guardrail: weak edge (<5%) cannot be HC
      isHighConfidence: confidenceScore >= highConfidenceThreshold && absEdge >= 5,
      isBestValue:      absEdge >= getMinEdgeForStat(context?.sport, context?.statType),
    };
  }

  // ─── Helpers extracted from _computeScores ────────────────────────────
  //
  // Kept as instance methods (not module-level helpers) so `this` stays
  // available if we ever want to add per-sport hooks. All are pure — no
  // I/O, no state. Unit-testable in isolation.

  /**
   * Resolve variance-guard caps from a sport's leagueProfile config, falling
   * back to defaults calibrated for consistent-log sports (NBA points, NFL
   * passing yards). See leagueProfiles.js DEFAULT_VARIANCE_GUARD comment.
   */
  _resolveVarianceCaps(varianceCfg = {}) {
    return {
      zeroValueCap:       Number.isFinite(varianceCfg.zeroValueCap)       ? varianceCfg.zeroValueCap       : 50,
      cvThreshold:        Number.isFinite(varianceCfg.cvThreshold)        ? varianceCfg.cvThreshold        : 0.4,
      cvOverThresholdCap: Number.isFinite(varianceCfg.cvOverThresholdCap) ? varianceCfg.cvOverThresholdCap : 50,
      thinBaselineGames:  Number.isFinite(varianceCfg.thinBaselineGames)  ? varianceCfg.thinBaselineGames  : 20,
      thinBaselineCap:    Number.isFinite(varianceCfg.thinBaselineCap)    ? varianceCfg.thinBaselineCap    : 80,
    };
  }

  /**
   * Compute mean / stdDev / CV / hasZeroValue for a finite-value array.
   * Guards against zero-length and single-value arrays (variance = 0 in
   * those cases so CV becomes 0 and won't trigger any cap).
   */
  _computeVarianceStats(values) {
    const total = values.length;
    if (total === 0) return { mean: 0, stdDev: 0, cv: 0, hasZeroValue: false };

    const hasZeroValue = values.some(v => v === 0);
    const mean = values.reduce((s, v) => s + v, 0) / total;
    const variance = total > 1
      ? values.reduce((sq, v) => sq + Math.pow(v - mean, 2), 0) / total
      : 0;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;
    return { mean, stdDev, cv, hasZeroValue };
  }

  /**
   * Apply the full set of confidence caps to a base score. Every cap uses
   * Math.min so the order is irrelevant — the final value is always the
   * TIGHTEST applicable ceiling. All caps are pure functions of the inputs.
   *
   * The two sport-agnostic edge caps (5% / 0.5%) live inside this helper
   * so both scoring paths (with-log and edge-only) apply the same logic.
   */
  _applyConfidenceCaps(baseConfidence, { hasZeroValue, cv, absEdge, baselineGamesCount, caps }) {
    let score = baseConfidence;
    if (hasZeroValue)                 score = Math.min(score, caps.zeroValueCap);
    if (cv > caps.cvThreshold)        score = Math.min(score, caps.cvOverThresholdCap);
    if (absEdge < 5)                  score = Math.min(score, 55);
    if (absEdge < 0.5)                score = Math.min(score, 30);
    if (baselineGamesCount < caps.thinBaselineGames) score = Math.min(score, caps.thinBaselineCap);
    return score;
  }

  /**
   * Edge-only caps — used both by _computeEdgeOnlyScores AND by the
   * no-recent-log path in _computeScores. Enforces "weak/no edge cannot
   * be HC" regardless of what tier the edge lookup produced.
   */
  _applyEdgeOnlyCaps(baseConfidence, absEdge) {
    let score = baseConfidence;
    if (absEdge < 5)   score = Math.min(score, 55);
    if (absEdge < 0.5) score = Math.min(score, 30);
    return score;
  }

  _edgeToConfidence(absEdge, context = {}) {
    const tiers = getLeagueProfile(context?.sport)?.scoring?.edgeToConfidenceTiers;
    if (Array.isArray(tiers) && tiers.length > 0) {
      const sorted = [...tiers]
        .filter((t) => Number.isFinite(t?.minAbsEdge) && Number.isFinite(t?.score))
        .sort((a, b) => b.minAbsEdge - a.minAbsEdge);

      for (const tier of sorted) {
        if (absEdge >= tier.minAbsEdge) return tier.score;
      }
    }

    if (absEdge >= 20) return 80;
    if (absEdge >= 12) return 65;
    if (absEdge >= 6)  return 50;
    return 30;
  }
}

module.exports = new StrategyService();


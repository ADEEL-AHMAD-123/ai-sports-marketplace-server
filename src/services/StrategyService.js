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

    let scored  = 0;
    let failed  = 0;
    let noStats = 0;

    for (const prop of props) {
      const spec = this._buildStatsFetchSpec(sport, prop);
      if (!spec) {
        const noStatsUpdate = this._buildNoStatsUpdate(prop, now);
        updateOps.push(noStatsUpdate);
        noStats++;
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
            updateOps.push(this._buildNoStatsUpdate(prop, now));
            noStats++;
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

    logger.info(`✅ [StrategyService] Scoring complete for ${sport}`, { scored, failed, noStats });
    return { scored, failed, noStats };
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

    const { recentStatValues = [], focusStatAvg = 0, baselineGamesCount = 30 } = processedStats || {};
    const parsedFocus = parseFloat(focusStatAvg);
    const hasFocusAvg = Number.isFinite(parsedFocus);
    const focusAvgNum = hasFocusAvg ? parsedFocus : 0;

    // Edge percentage
    const rawEdge = bettingLine > 0 && hasFocusAvg
      ? ((focusAvgNum - bettingLine) / bettingLine) * 100
      : 0;
    const edgePercentage = isNaN(rawEdge) ? 0 : parseFloat(rawEdge.toFixed(2));
    const absEdge        = Math.abs(edgePercentage);

    // Confidence score
    let confidenceScore;
    if (recentStatValues.length > 0) {
      const direction    = focusAvgNum >= bettingLine ? 'over' : 'under';
      const total        = recentStatValues.length;
      const maxWeight    = Number.isFinite(confidenceCfg.maxWeight) ? confidenceCfg.maxWeight : 1.4;
      const strongWeight = Number.isFinite(confidenceCfg.strongWeight) ? confidenceCfg.strongWeight : 1.4;
      const normalWeight = Number.isFinite(confidenceCfg.normalWeight) ? confidenceCfg.normalWeight : 1.0;
      const weakWeight   = Number.isFinite(confidenceCfg.weakWeight) ? confidenceCfg.weakWeight : 0.7;
      const strongMarginCap = Number.isFinite(confidenceCfg.strongMarginCap) ? confidenceCfg.strongMarginCap : 2.0;
      const normalMarginCap = Number.isFinite(confidenceCfg.normalMarginCap) ? confidenceCfg.normalMarginCap : 0.5;
      const normalMarginLineFactor = Number.isFinite(confidenceCfg.normalMarginLineFactor)
        ? confidenceCfg.normalMarginLineFactor
        : 0.5;

      // Line-scaled margins — sport-specific caps come from league profiles.
      const strongMargin = Math.min(strongMarginCap, bettingLine);
      const normalMargin = Math.min(normalMarginCap, bettingLine * normalMarginLineFactor);
      const weightedHits = recentStatValues.reduce((sum, val) => {
        const margin = direction === 'over' ? val - bettingLine : bettingLine - val;
        if (margin <= 0) return sum;
        return sum + (margin >= strongMargin ? strongWeight : margin >= normalMargin ? normalWeight : weakWeight);
      }, 0);

      // Variance detection: if game log has zeros or very high variance, reduce confidence
      const hasZeroValue = recentStatValues.some(v => v === 0);
      const mean = recentStatValues.length > 0
        ? recentStatValues.reduce((s, v) => s + v, 0) / recentStatValues.length
        : 0;
      const variance = recentStatValues.length > 1
        ? recentStatValues.reduce((sq, v) => sq + Math.pow(v - mean, 2), 0) / recentStatValues.length
        : 0;
      const stdDev = Math.sqrt(variance);
      const cv = mean > 0 ? stdDev / mean : 0; // coefficient of variation

      // If high variance in recent window, cap confidence lower
      let baseConfidence = Math.min(99, Math.round((weightedHits / (total * maxWeight)) * 100));
      if (hasZeroValue || cv > 0.4) {
        baseConfidence = Math.min(baseConfidence, 50);
      }
      // Weak edge (<5%) cannot have high confidence, even with strong game log
      if (absEdge < 5) {
        baseConfidence = Math.min(baseConfidence, 55);
      }
      // Zero/near-zero edge (<0.5%) is no edge at all — cap severely
      if (absEdge < 0.5) {
        baseConfidence = Math.min(baseConfidence, 30);
      }
      // Thin baseline (<20 games): cap at 80 — not enough data to be extremely confident
      if (baselineGamesCount < 20) {
        baseConfidence = Math.min(baseConfidence, 80);
      }
      confidenceScore = baseConfidence;
    } else {
      confidenceScore = this._edgeToConfidence(absEdge, context);
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
    if (!Number.isFinite(avg) || !bettingLine) return null;

    const rawEdge        = ((avg - bettingLine) / bettingLine) * 100;
    const edgePercentage = parseFloat(rawEdge.toFixed(2));
    const absEdge        = Math.abs(edgePercentage);
    let confidenceScore = this._edgeToConfidence(absEdge, context);
    
    // Weak edge (<5%) cannot have high confidence
    if (absEdge < 5) {
      confidenceScore = Math.min(confidenceScore, 55);
    }
    // Zero/near-zero edge (<0.5%) is no edge at all — cap severely
    if (absEdge < 0.5) {
      confidenceScore = Math.min(confidenceScore, 30);
    }

    return {
      edgePercentage,
      confidenceScore,
      // Guardrail: weak edge (<5%) cannot be HC
      isHighConfidence: confidenceScore >= highConfidenceThreshold && Math.abs(edgePercentage) >= 5,
      isBestValue:      absEdge >= getMinEdgeForStat(context?.sport, context?.statType),
    };
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


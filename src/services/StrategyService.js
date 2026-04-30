/**
 * StrategyService.js — Prop scoring engine
 *
 * Runs after every PropWatcher cycle. Outputs confidence scores and edge
 * percentages stored directly on each PlayerProp document in MongoDB.
 *
 * DATA SOURCES:
 *  NBA → API-Sports NBA v2 game logs (requires apiSportsPlayerId on prop)
 *  MLB → Official MLB Stats API (statsapi.mlb.com, lookup by playerName)
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
const { MIN_EDGE_PERCENTAGE, MIN_GAMES_REQUIRED } = require('../config/constants');
const { getMinEdgeForStat, getMinGamesForStat } = require('../config/leagueProfiles');
const logger = require('../config/logger');

const HC_THRESHOLD = 57;

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
      await PlayerProp.findByIdAndUpdate(prop._id, scores);

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

  async scoreAllPropsForSport(sport) {
    logger.info(`📊 [StrategyService] Scoring all props for ${sport}...`);

    const props = await PlayerProp.find({ sport, isAvailable: true }).lean();
    logger.info(`📊 [StrategyService] Found ${props.length} props to score for ${sport}`);

    let scored  = 0;
    let failed  = 0;
    let noStats = 0;

    for (const prop of props) {
      try {
        const adapter = getAdapter(sport);
        let stats     = null;

        if (sport === 'mlb') {
          stats = await adapter.fetchPlayerStats({
            playerName: prop.playerName,
            isPitcher:  prop.isPitcher || prop.statType === 'pitcher_strikeouts',
          });
        } else if (prop.apiSportsPlayerId) {
          stats = await adapter.fetchPlayerStats({ playerId: prop.apiSportsPlayerId });
        }

        if (!stats?.length) {
          // FIX A: use aiPredictedValue OR focusStatAvg — on first run aiPredictedValue is null
          const fallbackAvg = prop.aiPredictedValue ?? prop.focusStatAvg ?? null;
          const edgeScores  = this._computeEdgeOnlyScores(prop.line, fallbackAvg, { sport: prop.sport, statType: prop.statType });

          if (edgeScores) {
            await PlayerProp.findByIdAndUpdate(prop._id, edgeScores);
          } else {
            // No stats AND no avg to estimate from — hide prop
            await PlayerProp.findByIdAndUpdate(prop._id, { isAvailable: false });
            logger.debug('[StrategyService] Hidden — no stats, no fallback signal', {
              playerName: prop.playerName, statType: prop.statType,
            });
          }
          noStats++;
          continue;
        }

        // Pitchers start every ~5 days — require fewer games than batters
        const isPitcherProp = prop.statType === 'pitcher_strikeouts' || prop.isPitcher;
        const minGames      = getMinGamesForStat(sport, prop.statType);

        if (stats.length < minGames) {
          await PlayerProp.findByIdAndUpdate(prop._id, { isAvailable: false });
          logger.info(`[StrategyService] Hidden — only ${stats.length} games (need ${minGames})`, {
            playerName: prop.playerName,
          });
          continue;
        }

        await this.scoreProp(prop, stats);
        scored++;
      } catch (err) {
        failed++;
        logger.error('[StrategyService] Failed to score prop', {
          playerName: prop.playerName,
          statType:   prop.statType,
          error:      err.message,
        });
      }
    }

    logger.info(`✅ [StrategyService] Scoring complete for ${sport}`, { scored, failed, noStats });
    return { scored, failed };
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
    const { recentStatValues = [], focusStatAvg = 0 } = processedStats || {};
    const focusAvgNum = parseFloat(focusStatAvg) || 0;

    // Edge percentage
    const rawEdge = bettingLine > 0 && focusAvgNum > 0
      ? ((focusAvgNum - bettingLine) / bettingLine) * 100
      : 0;
    const edgePercentage = isNaN(rawEdge) ? 0 : parseFloat(rawEdge.toFixed(2));
    const absEdge        = Math.abs(edgePercentage);

    // Confidence score
    let confidenceScore;
    if (recentStatValues.length > 0) {
      const direction    = focusAvgNum >= bettingLine ? 'over' : 'under';
      const total        = recentStatValues.length;
      const maxWeight    = 1.4;
      // Line-scaled margins — small lines (0.5 hits) scored as fairly as large lines (25 pts)
      const strongMargin = Math.min(2.0, bettingLine);
      const normalMargin = Math.min(0.5, bettingLine * 0.5);
      const weightedHits = recentStatValues.reduce((sum, val) => {
        const margin = direction === 'over' ? val - bettingLine : bettingLine - val;
        if (margin <= 0) return sum;
        return sum + (margin >= strongMargin ? 1.4 : margin >= normalMargin ? 1.0 : 0.7);
      }, 0);
      // Cap at 99 — 100 implies impossible certainty and breaks the arc UI
      confidenceScore = Math.min(99, Math.round((weightedHits / (total * maxWeight)) * 100));
    } else {
      confidenceScore = this._edgeToConfidence(absEdge);
    }

    return {
      confidenceScore,
      edgePercentage,
      aiPredictedValue: focusAvgNum || null,
      isHighConfidence:  confidenceScore >= HC_THRESHOLD,
      isBestValue:       absEdge >= getMinEdgeForStat(context?.sport, context?.statType),
    };
  }

  _computeEdgeOnlyScores(bettingLine, focusStatAvg, context = {}) {
    const avg = parseFloat(focusStatAvg) || 0;
    if (!avg || !bettingLine) return null;

    const rawEdge        = ((avg - bettingLine) / bettingLine) * 100;
    const edgePercentage = parseFloat(rawEdge.toFixed(2));
    const absEdge        = Math.abs(edgePercentage);
    const confidenceScore = this._edgeToConfidence(absEdge);

    return {
      edgePercentage,
      confidenceScore,
      isHighConfidence: confidenceScore >= HC_THRESHOLD,
      isBestValue:      absEdge >= getMinEdgeForStat(context?.sport, context?.statType),
    };
  }

  _edgeToConfidence(absEdge) {
    if (absEdge >= 20) return 80;
    if (absEdge >= 12) return 65;
    if (absEdge >= 6)  return 50;
    return 30;
  }
}

module.exports = new StrategyService();


/**
 * StrategyService.js — Strategy Engine
 *
 * Calculates advanced betting metrics and tags props for the filter system.
 * Called by the Prop Watcher cron job every 30 minutes.
 *
 * Outputs:
 *  confidenceScore  — how often the player has hit this prop recently
 *  edgePercentage   — how much the player's average differs from the line
 *  isHighConfidence — tagged if confidenceScore is above threshold
 *  isBestValue      — tagged if edgePercentage is above threshold
 *
 * BETTING GLOSSARY:
 *  "Sharp money"  = bets from professional/winning bettors (opposite of "public money")
 *  "Line value"   = when the line is mispriced relative to the true probability
 *  "Hit rate"     = how often a player exceeds/falls below a line historically
 */

const PlayerProp = require('../models/PlayerProp.model');
const { getAdapter } = require('./adapters/adapterRegistry');
const {
  MIN_CONFIDENCE_HITS,
  CONFIDENCE_WINDOW,
  MIN_EDGE_PERCENTAGE,
} = require('../config/constants');
const logger = require('../config/logger');

class StrategyService {
  /**
   * Run the strategy engine on a specific player prop.
   * Calculates scores and updates the prop in MongoDB.
   *
   * @param {Object} prop   - PlayerProp document (lean object)
   * @param {Array}  stats  - Recent player stats array (from adapter.fetchPlayerStats)
   * @returns {Promise<Object>} Updated strategy scores
   */
  async scoreProp(prop, stats) {
    logger.debug('📊 [StrategyService] Scoring prop', {
      playerName: prop.playerName,
      statType: prop.statType,
      line: prop.line,
    });

    try {
      const adapter = getAdapter(prop.sport);

      // Apply formulas to get processed stats (including recentStatValues)
      const processedStats = adapter.applyFormulas(stats, prop.statType);
      const { recentStatValues, focusStatAvg } = processedStats;

      // ── Confidence Score ────────────────────────────────────────────────────
      // Direction: we analyze both directions and pick the one with more edge
      // For a prop at line 25.5 with avg 28 → OVER has confidence
      // For a prop at line 25.5 with avg 22 → UNDER has confidence
      const overHits = (recentStatValues || []).filter((v) => v > prop.line).length;
      const underHits = (recentStatValues || []).filter((v) => v < prop.line).length;
      const totalGames = (recentStatValues || []).length || 1;

      // Pick the direction with more historical hits
      const bestHits = Math.max(overHits, underHits);
      const confidenceScore = Math.round((bestHits / totalGames) * 100);

      // ── Edge Percentage ─────────────────────────────────────────────────────
      // Positive edge = player averages OVER the line (lean OVER)
      // Negative edge = player averages UNDER the line (lean UNDER)
      const edgePercentage = prop.line > 0
        ? parseFloat(((focusStatAvg - prop.line) / prop.line) * 100)
        : 0;

      // ── AI-predicted value (we use recent average as our prediction) ────────
      // This is the adapter-computed estimate before sending to OpenAI.
      // In future phases this could be a more sophisticated model.
      const aiPredictedValue = focusStatAvg;

      // ── Tags ────────────────────────────────────────────────────────────────
      // isHighConfidence: player has hit this prop in 8/10 recent games
      const isHighConfidence = confidenceScore >= (MIN_CONFIDENCE_HITS / CONFIDENCE_WINDOW) * 100;

      // isBestValue: the player's average deviates from the line by 15%+
      // This suggests the bookmaker's line is potentially mispriced = "value bet"
      const isBestValue = Math.abs(edgePercentage) >= MIN_EDGE_PERCENTAGE;

      const scores = {
        confidenceScore,
        edgePercentage: parseFloat(edgePercentage.toFixed(2)),
        aiPredictedValue,
        isHighConfidence,
        isBestValue,
      };

      // Update the prop in MongoDB with the new scores
      await PlayerProp.findByIdAndUpdate(prop._id, scores);

      logger.debug('✅ [StrategyService] Prop scored', {
        playerName: prop.playerName,
        statType: prop.statType,
        line: prop.line,
        ...scores,
      });

      return scores;
    } catch (error) {
      logger.error('❌ [StrategyService] Failed to score prop', {
        propId: prop._id,
        playerName: prop.playerName,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Score all available props for a given sport.
   * Called by the Prop Watcher cron job.
   *
   * @param {string} sport
   * @returns {Promise<{ scored: number, failed: number }>}
   */
  async scoreAllPropsForSport(sport) {
    logger.info(`📊 [StrategyService] Scoring all props for ${sport}...`);

    // Only score available props (market is still open)
    const props = await PlayerProp.find({ sport, isAvailable: true }).lean();

    logger.info(`📊 [StrategyService] Found ${props.length} props to score for ${sport}`);

    let scored = 0;
    let failed = 0;

    for (const prop of props) {
      try {
        if (!prop.apiSportsPlayerId) {
          logger.debug('[StrategyService] Skipping prop — no apiSportsPlayerId', {
            playerName: prop.playerName,
            statType: prop.statType,
          });
          continue;
        }

        const adapter = getAdapter(sport);
        const stats = await adapter.fetchPlayerStats({ playerId: prop.apiSportsPlayerId });
        await this.scoreProp(prop, stats);
        scored++;
      } catch (err) {
        failed++;
        logger.error('[StrategyService] Failed to score prop', {
          playerName: prop.playerName,
          error: err.message,
        });
      }
    }

    logger.info(`✅ [StrategyService] Scoring complete for ${sport}`, { scored, failed });
    return { scored, failed };
  }
}

module.exports = new StrategyService(); // Singleton
/**
 * NHLInsightPipeline.js — NHL-specific insight context enrichment
 *
 * Currently minimal — placeholder for future NHL context:
 *   - Goalie matchup (who's starting in goal)
 *   - Power play rate (team PP% affects goal/assist props)
 *   - Playoff intensity (similar to NBA playoff detection)
 *
 * TO TEST INDEPENDENTLY:
 *   const pipeline = require('./NHLInsightPipeline');
 *   const ctx = await pipeline.getInsightContext(prop, game);
 */

/**
 * @param {{ statType, playerName }} prop
 * @param {Object} game
 * @returns {Promise<{}>}
 */
async function getInsightContext(prop, game) {
  // TODO Session N: add goalie matchup, PP%, playoff detection
  return {};
}

module.exports = { getInsightContext };


/**
 * NBAInsightPipeline.js — NBA-specific insight context enrichment
 *
 * Called by InsightService during Step 6 for NBA insights.
 * Extracts all NBA-specific context into ONE call:
 *   - Playoff detection (Session 1)
 *   - Opponent defensive stats (Session 3)
 *
 * Returns a plain context object passed directly into buildNBAPrompt().
 *
 * TO TEST INDEPENDENTLY:
 *   const pipeline = require('./NBAInsightPipeline');
 *   const ctx = await pipeline.getInsightContext(prop, game);
 *   console.log(ctx);
 */

const { detectNBAGameContext }  = require('../../shared/gameContext');
const { getGameDefensiveContext } = require('../../sports/nba/NBADefensiveStatsService');
const logger = require('../../../config/logger');

/**
 * Build all NBA-specific prompt context for one prop+game.
 * Safe to call in isolation — no side effects.
 *
 * @param {{ statType, playerName }} prop
 * @param {Object} game — Game document (lean)
 * @returns {Promise<{ gameContext, defensiveContext }>}
 */
async function getInsightContext(prop, game) {
  const [gameContext, defensiveContext] = await Promise.allSettled([
    _getPlayoffContext(game),
    _getDefensiveContext(game),
  ]);

  return {
    gameContext:      gameContext.status      === 'fulfilled' ? gameContext.value      : null,
    defensiveContext: defensiveContext.status === 'fulfilled' ? defensiveContext.value : null,
  };
}

async function _getPlayoffContext(game) {
  try {
    return detectNBAGameContext(game);
  } catch (err) {
    logger.warn('[NBAInsightPipeline] playoff context failed', { error: err.message });
    return null;
  }
}

async function _getDefensiveContext(game) {
  try {
    const ctx = await getGameDefensiveContext(game);
    return (ctx.homeTeamDef || ctx.awayTeamDef) ? ctx : null;
  } catch (err) {
    logger.warn('[NBAInsightPipeline] defensive context failed', { error: err.message });
    return null;
  }
}

module.exports = { getInsightContext };


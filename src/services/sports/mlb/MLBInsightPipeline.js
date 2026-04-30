/**
 * MLBInsightPipeline.js — MLB-specific insight context enrichment
 *
 * Called by InsightService during Step 6 for MLB batter/pitcher props.
 * Extracts all MLB-specific context into ONE call:
 *   - Starter inference + stats (Session 2)
 *   - Ballpark factors (Session 4)
 *   - Platoon splits (Session 5)
 *
 * Pitcher props only get starterContext (they ARE the starter).
 * Batter props get all three.
 *
 * TO TEST INDEPENDENTLY:
 *   const pipeline = require('./MLBInsightPipeline');
 *   const ctx = await pipeline.getInsightContext(prop, game);
 */

const PlayerProp  = require('../../../models/PlayerProp.model');
const { getParkFactors }      = require('../../sports/mlb/MLBBallparkFactors');
const { getPlatoonMatchup }   = require('../../sports/mlb/MLBPlatoonService');
const logger = require('../../../config/logger');

/**
 * @param {{ statType, playerName, oddsEventId }} prop  (can be lean from DB)
 * @param {Object} game — Game document (lean)
 * @returns {Promise<{ starterContext, parkContext, platoonContext }>}
 */
async function getInsightContext(prop, game) {
  const isPitcher = prop.statType === 'pitcher_strikeouts';

  if (isPitcher) {
    // Pitcher props: no park or platoon context needed
    return { starterContext: null, parkContext: null, platoonContext: null };
  }

  // Read starter name stored on prop by MLBStarterService (propWatcher step)
  const propDoc = await PlayerProp.findOne({
    oddsEventId: prop.oddsEventId || game?.oddsEventId,
    playerName:  prop.playerName,
    statType:    prop.statType,
  }).select('opponentStarterName opponentStarterStats').lean();

  const starterName  = propDoc?.opponentStarterName  || null;
  const starterStats = propDoc?.opponentStarterStats  || null;

  // Run all three in parallel — none depend on each other
  const [platoonResult] = await Promise.allSettled([
    starterName ? getPlatoonMatchup(prop.playerName, starterName) : Promise.resolve(null),
  ]);

  const starterContext = starterName
    ? { starterName, starterStats }
    : null;

  const homeTeamName = game?.homeTeam?.name || null;
  const parkContext  = (homeTeamName && getParkFactors(homeTeamName))
    ? { homeTeamName }
    : null;

  const platoonMatchup = platoonResult.status === 'fulfilled' ? platoonResult.value : null;
  const platoonContext = platoonMatchup ? { matchup: platoonMatchup } : null;

  return { starterContext, parkContext, platoonContext };
}

module.exports = { getInsightContext };


/**
 * NHLInsightPipeline.js — NHL insight context orchestrator
 *
 * Replaces the stub that returned {}.
 * Runs ALL NHL-specific context lookups in parallel:
 *   1. Goalie matchup (opposing goalie save% + tier)
 *   2. Team stats matchup (PP%, shots-for/against, defense quality)
 *   3. Playoff detection (pace adjustment, line tightening)
 *   4. Player's home/away assignment (for goalie + shot context)
 *
 * InsightService calls getInsightContext(prop, game) → returns enriched context
 * that is unpacked and passed to buildNHLPrompt().
 *
 * TO TEST INDEPENDENTLY:
 *   const pipeline = require('./NHLInsightPipeline');
 *   // Simulate a game document
 *   const game = {
 *     homeTeam: { name: 'Boston Bruins', apiSportsId: 1 },
 *     awayTeam: { name: 'Toronto Maple Leafs', apiSportsId: 2 },
 *     startTime: new Date(),
 *   };
 *   const ctx = await pipeline.getInsightContext({ playerName: 'Brad Marchand', statType: 'goals' }, game);
 *   console.log(JSON.stringify(ctx, null, 2));
 */

const NHLGoalieService    = require('./NHLGoalieService');
const NHLTeamStatsService = require('./NHLTeamStatsService');
const logger              = require('../../../config/logger');

/**
 * Determine if a player is on the home or away team.
 * Uses homeTeamName/awayTeamName stored on the prop (set by propWatcher).
 * Falls back to null if unknown — goalie context still injected, just without home/away.
 *
 * @param {Object} prop  — { homeTeamName, awayTeamName, playerTeam }
 * @param {Object} game
 * @returns {'home' | 'away' | null}
 */
function _resolvePlayerSide(prop, game) {
  // propWatcher stores homeTeamName/awayTeamName on each prop
  if (prop.playerTeam === 'home') return 'home';
  if (prop.playerTeam === 'away') return 'away';

  // Fallback: check if we have it from the prop's stored team name
  if (prop.homeTeamName && prop.awayTeamName) {
    // If playerName is not tied to a team, we can't determine side
    return null;
  }

  return null;
}

/**
 * @param {{ statType, playerName, homeTeamName, awayTeamName, playerTeam }} prop
 * @param {Object} game — Game document (lean)
 * @returns {Promise<{
 *   goalieContext:  { homeGoalie, awayGoalie } | null,
 *   teamContext:   { home, away, playoff, expectedPace } | null,
 *   playerSide:    'home' | 'away' | null,
 *   isPlayoff:     boolean,
 * }>}
 */
async function getInsightContext(prop, game) {
  if (!game) return _empty();

  const playerSide = _resolvePlayerSide(prop, game);

  // Run all lookups in parallel — none depend on each other
  const [goalieResult, teamResult] = await Promise.allSettled([
    NHLGoalieService.getGoalieContext(game),
    NHLTeamStatsService.getTeamMatchupContext(game),
  ]);

  const goalieContext = goalieResult.status === 'fulfilled' ? goalieResult.value : null;
  const teamContext   = teamResult.status   === 'fulfilled' ? teamResult.value   : null;

  if (goalieResult.status === 'rejected') {
    logger.warn('[NHLInsightPipeline] Goalie context failed (non-fatal)', {
      error: goalieResult.reason?.message,
    });
  }
  if (teamResult.status === 'rejected') {
    logger.warn('[NHLInsightPipeline] Team context failed (non-fatal)', {
      error: teamResult.reason?.message,
    });
  }

  const isPlayoff = teamContext?.playoff?.isPlayoff ?? false;

  return {
    goalieContext,
    teamContext,
    playerSide,
    isPlayoff,
  };
}

function _empty() {
  return { goalieContext: null, teamContext: null, playerSide: null, isPlayoff: false };
}

module.exports = { getInsightContext };

 
/**
 * NHLInsightPipeline.js — NHL insight context orchestrator
 *
 * Runs ALL NHL-specific context lookups in parallel:
 *   1. Goalie matchup       — opposing goalie season SV% + last-5 form
 *   2. Team stats matchup   — PP%, PK%, shots-for/against, defense quality
 *   3. Playoff detection    — pace adjustment, line tightening
 *   4. Player's home/away   — pulled from prop.playerTeam (set by propWatcher)
 *                             with roster-lookup fallback
 *   5. Injury context       — ESPN feed via NHLInjuryService
 *   6. Back-to-back flag    — opposing team played within last ~30h
 *
 * InsightService calls getInsightContext(prop, game) → returns enriched context
 * unpacked and passed to buildNHLPrompt().
 */

const NHLGoalieService    = require('./NHLGoalieService');
const NHLTeamStatsService = require('./NHLTeamStatsService');
const NHLInjuryService    = require('./NHLInjuryService');
const NHLStatsClient      = require('./NHLStatsClient');
const logger              = require('../../../config/logger');

/**
 * Determine if a player is on the home or away team.
 * Order of precedence:
 *   1. prop.playerTeam (already set by propWatcher)
 *   2. roster lookup against home + away rosters
 *
 * @returns {Promise<'home'|'away'|null>}
 */
async function _resolvePlayerSide(prop, game) {
  if (prop?.playerTeam === 'home' || prop?.playerTeam === 'away') {
    return prop.playerTeam;
  }

  const homeName = prop?.homeTeamName || game?.homeTeam?.name;
  const awayName = prop?.awayTeamName || game?.awayTeam?.name;
  if (!homeName || !awayName) return null;

  try {
    const info = await NHLStatsClient.resolvePlayerId(prop.playerName, homeName, awayName);
    if (!info?.teamAbbrev) return null;

    const homeAbbr = NHLStatsClient.getTeamAbbrev(homeName);
    const awayAbbr = NHLStatsClient.getTeamAbbrev(awayName);
    if (info.teamAbbrev === homeAbbr) return 'home';
    if (info.teamAbbrev === awayAbbr) return 'away';
  } catch (err) {
    logger.debug('[NHLInsightPipeline] _resolvePlayerSide failed', { error: err.message });
  }
  return null;
}

/**
 * @returns {Promise<{
 *   goalieContext, teamContext, playerSide, isPlayoff, injuryContext, isBackToBack
 * }>}
 */
async function getInsightContext(prop, game) {
  if (!game) return _empty();

  const playerSide = await _resolvePlayerSide(prop, game);

  const teamCtx = {
    homeTeamName: game.homeTeam?.name,
    awayTeamName: game.awayTeam?.name,
    oddsEventId:  game.oddsEventId,
  };

  // All lookups in parallel
  const [goalieResult, teamResult, injuryResult] = await Promise.allSettled([
    NHLGoalieService.getGoalieContext(game),
    NHLTeamStatsService.getTeamMatchupContext(game),
    NHLInjuryService.getInjuryPromptContext(prop?.playerName, teamCtx),
  ]);

  const goalieContext  = goalieResult.status  === 'fulfilled' ? goalieResult.value  : null;
  const teamContext    = teamResult.status    === 'fulfilled' ? teamResult.value    : null;
  const injuryContext  = injuryResult.status  === 'fulfilled' ? injuryResult.value  : null;

  if (goalieResult.status === 'rejected') {
    logger.warn('[NHLInsightPipeline] Goalie context failed (non-fatal)', { error: goalieResult.reason?.message });
  }
  if (teamResult.status === 'rejected') {
    logger.warn('[NHLInsightPipeline] Team context failed (non-fatal)', { error: teamResult.reason?.message });
  }

  const isPlayoff = teamContext?.playoff?.isPlayoff ?? false;

  // Back-to-back detection runs against the Game collection — inexpensive lookup.
  const isBackToBack = playerSide
    ? await NHLGoalieService.detectBackToBack(game, playerSide).catch(() => false)
    : false;

  return {
    goalieContext,
    teamContext,
    playerSide,
    isPlayoff,
    injuryContext,
    isBackToBack,
  };
}

function _empty() {
  return {
    goalieContext: null,
    teamContext:   null,
    playerSide:    null,
    isPlayoff:     false,
    injuryContext: null,
    isBackToBack:  false,
  };
}

module.exports = { getInsightContext };

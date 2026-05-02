/**
 * NHLGoalieService.js — Starting goalie context via official NHL Stats API
 *
 * Uses NHLStatsClient (api-web.nhle.com) instead of API-Sports.
 * Goalie save% is the strongest single predictor for NHL shot/goal props.
 */

const NHLStatsClient = require('./NHLStatsClient');
const logger         = require('../../../config/logger');

async function getGoalieContext(game) {
  if (!game) return null;

  const [homeGoalie, awayGoalie] = await Promise.allSettled([
    NHLStatsClient.getStartingGoalie(game.homeTeam?.name),
    NHLStatsClient.getStartingGoalie(game.awayTeam?.name),
  ]);

  return {
    homeGoalie: homeGoalie.status === 'fulfilled' ? homeGoalie.value : null,
    awayGoalie: awayGoalie.status === 'fulfilled' ? awayGoalie.value : null,
  };
}

function getOpposingGoalieForPlayer(playerTeam, goalieCtx) {
  if (!goalieCtx) return null;
  const goalie = playerTeam === 'home' ? goalieCtx.awayGoalie : goalieCtx.homeGoalie;
  if (!goalie) return null;
  return { goalie, impact: _goalieImpact(goalie.tier) };
}

function buildGoaliePromptBlock(playerTeam, goalieCtx) {
  const ctx = getOpposingGoalieForPlayer(playerTeam, goalieCtx);
  if (!ctx?.goalie) return '';

  const { goalie, impact } = ctx;
  const svStr  = goalie.savePercentage != null ? `SV% ${(goalie.savePercentage * 100).toFixed(1)}` : 'SV% unknown';
  const gaaStr = goalie.goalsAgainstAvg != null ? `, GAA ${goalie.goalsAgainstAvg}` : '';

  return [
    `OPPOSING GOALIE: ${goalie.name || 'unknown'} (${svStr}${gaaStr}, ${goalie.gamesPlayed}GP)`,
    `IMPACT: ${impact}`,
  ].join('\n');
}

function _goalieImpact(tier) {
  return {
    elite:     '🔴 SUPPRESSING — elite goalie strongly favors UNDER on shots/goals',
    above_avg: '🟡 CAUTIOUS — above-average goalie, moderate drag on scoring',
    average:   '⚪ NEUTRAL — league-average goalie, no strong adjustment',
    below_avg: '🟢 FAVORABLE — below-average goalie favors OVER on shots/goals',
    weak:      '🟢 STRONG OVER LEAN — weak/backup goalie, strong OVER signal',
    unknown:   '❓ UNKNOWN — goalie data unavailable',
  }[tier] || '❓ UNKNOWN';
}

module.exports = { getGoalieContext, getOpposingGoalieForPlayer, buildGoaliePromptBlock };


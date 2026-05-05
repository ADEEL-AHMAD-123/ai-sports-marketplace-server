/**
 * NHLGoalieService.js — Starting goalie context via official NHL Stats API
 *
 * Goalie save% — both season and last-5 — is the strongest single predictor
 * for NHL shot/goal props. We additionally surface back-to-back context
 * because the season-starter is meaningfully less likely to start the
 * second half of a B2B.
 */

const NHLStatsClient = require('./NHLStatsClient');
const logger         = require('../../../config/logger');

async function getGoalieContext(game) {
  if (!game) return null;

  const [homeGoalie, awayGoalie] = await Promise.allSettled([
    NHLStatsClient.getStartingGoalie(game.homeTeam?.name, { includeBackup: true }),
    NHLStatsClient.getStartingGoalie(game.awayTeam?.name, { includeBackup: true }),
  ]);

  return {
    homeGoalie: homeGoalie.status === 'fulfilled' ? homeGoalie.value : null,
    awayGoalie: awayGoalie.status === 'fulfilled' ? awayGoalie.value : null,
  };
}

/**
 * Detect whether the player's team is on the second half of a back-to-back.
 * Looks for any FINAL or LIVE game for the team within the prior ~30 hours.
 *
 * @param {Object} game        — current game document (has homeTeam/awayTeam)
 * @param {'home'|'away'} side
 * @returns {Promise<boolean>}
 */
async function detectBackToBack(game, side) {
  if (!game || !side) return false;
  try {
    const { Game, GAME_STATUS } = require('../../../models/Game.model');
    const teamName = side === 'home' ? game.homeTeam?.name : game.awayTeam?.name;
    if (!teamName) return false;

    const start = new Date(game.startTime);
    if (isNaN(+start)) return false;
    const since = new Date(start.getTime() - 30 * 3600 * 1000);

    const prior = await Game.findOne({
      sport: 'nhl',
      _id: { $ne: game._id },
      startTime: { $gte: since, $lt: start },
      status: { $in: [GAME_STATUS.FINAL, GAME_STATUS.LIVE, GAME_STATUS.SCHEDULED] },
      $or: [
        { 'homeTeam.name': teamName },
        { 'awayTeam.name': teamName },
      ],
    }).select('_id startTime').lean();

    return !!prior;
  } catch (err) {
    logger.debug('[NHLGoalieService] detectBackToBack failed', { error: err.message });
    return false;
  }
}

function getOpposingGoalieForPlayer(playerTeam, goalieCtx) {
  if (!goalieCtx) return null;
  const goalie = playerTeam === 'home' ? goalieCtx.awayGoalie : goalieCtx.homeGoalie;
  if (!goalie) return null;
  return { goalie, impact: _goalieImpact(goalie.tier) };
}

function buildGoaliePromptBlock(playerTeam, goalieCtx, opts = {}) {
  const ctx = getOpposingGoalieForPlayer(playerTeam, goalieCtx);
  if (!ctx?.goalie) return '';

  const { goalie, impact } = ctx;
  const svStr  = goalie.savePercentage != null ? `SV% ${(goalie.savePercentage * 100).toFixed(1)}` : 'SV% unknown';
  const gaaStr = goalie.goalsAgainstAvg != null ? `, GAA ${goalie.goalsAgainstAvg}` : '';

  const lines = [
    `OPPOSING GOALIE: ${goalie.name || 'unknown'} (${svStr}${gaaStr}, ${goalie.gamesPlayed}GP)`,
  ];

  // Recent form callout — meaningful when the season tier and effective tier diverge
  if (goalie.recentForm?.recentSavePct != null) {
    const recentSV = (goalie.recentForm.recentSavePct * 100).toFixed(1);
    const tag = goalie.recentForm.isHot
      ? '🔥 HOT'
      : goalie.recentForm.isCold
        ? '❄️ COLD'
        : 'steady';
    lines.push(`  RECENT (last ${goalie.recentForm.startsCount}): SV% ${recentSV} (${tag})`);
  }

  // Backup callout — useful for AI when B2B pressure or confirmed-starter uncertainty
  if (opts.isBackToBack && goalie.backup?.name) {
    lines.push(`  ⚠️ B2B PRESSURE: opposing team played within 30h — backup ${goalie.backup.name} may start (SV% ${(goalie.backup.savePercentage ?? 0) ? (goalie.backup.savePercentage * 100).toFixed(1) : '?'})`);
  }

  lines.push(`IMPACT: ${impact}`);
  return lines.join('\n');
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

module.exports = {
  getGoalieContext,
  getOpposingGoalieForPlayer,
  buildGoaliePromptBlock,
  detectBackToBack,
};

/**
 * NHLTeamStatsService.js — Team context via official NHL Stats API
 *
 * Uses NHLStatsClient (api-web.nhle.com) instead of API-Sports.
 */

const NHLStatsClient = require('./NHLStatsClient');
const logger         = require('../../../config/logger');

function detectPlayoffContext(game) {
  const start = new Date(game.startTime);
  const month = start.getMonth() + 1;
  const day   = start.getDate();
  const isPlayoff = (month === 4 && day >= 19) || month === 5 || (month === 6 && day <= 30);
  return {
    isPlayoff,
    intensity: isPlayoff
      ? '⚡ PLAYOFF — defensive pace, goals/shots 10-15% below regular season. Lines conservative.'
      : null,
  };
}

async function getTeamMatchupContext(game) {
  if (!game) return null;

  const [homeStats, awayStats] = await Promise.allSettled([
    NHLStatsClient.getTeamStats(game.homeTeam?.name),
    NHLStatsClient.getTeamStats(game.awayTeam?.name),
  ]);

  const home    = homeStats.status === 'fulfilled' ? homeStats.value : null;
  const away    = awayStats.status === 'fulfilled' ? awayStats.value : null;
  const playoff = detectPlayoffContext(game);

  let expectedPace = null;
  if (home?.shotsForPerGame && away?.shotsAgainstPerGame) {
    expectedPace = {
      homeExpectedShots: parseFloat(((home.shotsForPerGame + away.shotsAgainstPerGame) / 2).toFixed(1)),
      awayExpectedShots: parseFloat(((away.shotsForPerGame + home.shotsAgainstPerGame) / 2).toFixed(1)),
    };
  }

  return { home, away, playoff, expectedPace };
}

function buildTeamContextPromptBlock(playerTeam, matchupCtx) {
  if (!matchupCtx) return '';
  const lines = [];
  const { home, away, playoff, expectedPace } = matchupCtx;

  if (playoff?.isPlayoff) lines.push(playoff.intensity);

  const playerTeamStats = playerTeam === 'home' ? home : away;
  const oppTeamStats    = playerTeam === 'home' ? away : home;

  if (playerTeamStats?.ppPct != null) {
    const ppTier = playerTeamStats.ppPct >= 25 ? '🔥 ELITE PP'
      : playerTeamStats.ppPct >= 20 ? 'AVERAGE PP' : '❄️ WEAK PP';
    lines.push(`PLAYER TEAM PP: ${playerTeamStats.ppPct.toFixed(1)}% (${ppTier})`);
  }

  if (oppTeamStats?.goalsAgainstPerGame != null) {
    const defTier = oppTeamStats.goalsAgainstPerGame <= 2.5 ? '🔴 ELITE DEFENSE'
      : oppTeamStats.goalsAgainstPerGame >= 3.2 ? '🟢 POROUS DEFENSE' : '⚪ AVG DEFENSE';
    lines.push(`OPP TEAM GA/G: ${oppTeamStats.goalsAgainstPerGame} (${defTier})`);
  }

  if (expectedPace) {
    const shots = playerTeam === 'home'
      ? expectedPace.homeExpectedShots
      : expectedPace.awayExpectedShots;
    if (shots) lines.push(`EXPECTED SHOTS THIS GAME: ~${shots}/game based on matchup`);
  }

  return lines.join('\n');
}

module.exports = { getTeamMatchupContext, detectPlayoffContext, buildTeamContextPromptBlock };


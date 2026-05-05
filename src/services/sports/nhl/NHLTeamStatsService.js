/**
 * NHLTeamStatsService.js — Team context via official NHL Stats API
 *
 * Builds the matchup context block used in the AI prompt:
 *   - Team PP% / PK%
 *   - Goal/shot pace (for + against)
 *   - Expected shots for the player's side, given the matchup
 *   - Playoff intensity flag (delegated to NHLStatsClient.getGameType)
 */

const NHLStatsClient = require('./NHLStatsClient');

function detectPlayoffContext(game) {
  const start = game?.startTime ? new Date(game.startTime) : new Date();
  const isPlayoff = NHLStatsClient.getGameType(start) === 3;
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
  if (
    Number.isFinite(home?.shotsForPerGame)     &&
    Number.isFinite(home?.shotsAgainstPerGame) &&
    Number.isFinite(away?.shotsForPerGame)     &&
    Number.isFinite(away?.shotsAgainstPerGame)
  ) {
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

  if (playoff?.isPlayoff && playoff.intensity) lines.push(playoff.intensity);

  const playerTeamStats = playerTeam === 'home' ? home : away;
  const oppTeamStats    = playerTeam === 'home' ? away : home;

  if (Number.isFinite(playerTeamStats?.ppPct)) {
    const v = playerTeamStats.ppPct;
    const ppTier = v >= 25 ? '🔥 ELITE PP' : v >= 20 ? 'AVERAGE PP' : '❄️ WEAK PP';
    lines.push(`PLAYER TEAM PP: ${v.toFixed(1)}% (${ppTier})`);
  } else if (Number.isFinite(playerTeamStats?.ppGoalSharePct)) {
    lines.push(`PLAYER TEAM PP-GOAL SHARE: ${playerTeamStats.ppGoalSharePct}% of goals come on PP`);
  }

  if (Number.isFinite(oppTeamStats?.pkPct)) {
    const v = oppTeamStats.pkPct;
    const tier = v >= 82 ? '🔴 ELITE PK (suppresses PP)' : v >= 78 ? '⚪ AVG PK' : '🟢 WEAK PK (PP-friendly)';
    lines.push(`OPP TEAM PK: ${v.toFixed(1)}% (${tier})`);
  }

  if (Number.isFinite(oppTeamStats?.goalsAgainstPerGame)) {
    const v = oppTeamStats.goalsAgainstPerGame;
    const defTier = v <= 2.5 ? '🔴 ELITE DEFENSE' : v >= 3.2 ? '🟢 POROUS DEFENSE' : '⚪ AVG DEFENSE';
    lines.push(`OPP TEAM GA/G: ${v} (${defTier})`);
  }

  if (Number.isFinite(oppTeamStats?.shotsAgainstPerGame)) {
    const v = oppTeamStats.shotsAgainstPerGame;
    const tier = v >= 32 ? '🟢 SHOTS FRIENDLY (allows lots of shots)' : v <= 27 ? '🔴 SHOTS RESTRICTIVE' : '⚪ avg shots-against';
    lines.push(`OPP SHOTS-AGAINST/G: ${v} (${tier})`);
  }

  if (expectedPace) {
    const shots = playerTeam === 'home'
      ? expectedPace.homeExpectedShots
      : expectedPace.awayExpectedShots;
    if (Number.isFinite(shots)) {
      lines.push(`EXPECTED TEAM SHOTS THIS GAME: ~${shots} based on matchup pace`);
    }
  }

  return lines.join('\n');
}

module.exports = { getTeamMatchupContext, detectPlayoffContext, buildTeamContextPromptBlock };

/**
 * SoccerInsightPipeline.js — Soccer-specific insight context enrichment
 *
 * Adds lightweight match context used by soccer prompting:
 *  - league context (leagueId, competition name from game record)
 *  - recent team form (goals for/against from recent final matches in same league)
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const logger = require('../../../config/logger');

const RECENT_GAMES = 5;

const _toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const _safeDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};

async function _teamRecentForm(teamName, leagueId, beforeTime) {
  if (!teamName || !beforeTime) return null;

  const filter = {
    sport: 'soccer',
    status: GAME_STATUS.FINAL,
    startTime: { $lt: beforeTime },
    $or: [{ 'homeTeam.name': teamName }, { 'awayTeam.name': teamName }],
  };
  if (leagueId) filter.leagueId = leagueId;

  const rows = await Game.find(filter)
    .sort({ startTime: -1 })
    .limit(RECENT_GAMES)
    .select('homeTeam.name awayTeam.name score startTime')
    .lean();

  if (!rows.length) return null;

  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const g of rows) {
    const homePts = _toNum(g?.score?.home);
    const awayPts = _toNum(g?.score?.away);
    if (homePts == null || awayPts == null) continue;

    const isHome = g?.homeTeam?.name === teamName;
    goalsFor     += isHome ? homePts : awayPts;
    goalsAgainst += isHome ? awayPts : homePts;
  }

  const count = rows.length;
  return {
    games: count,
    goalsForPerGame:     count ? Number((goalsFor     / count).toFixed(2)) : null,
    goalsAgainstPerGame: count ? Number((goalsAgainst / count).toFixed(2)) : null,
  };
}

function _buildMatchContext(game) {
  const start = _safeDate(game?.startTime);
  if (!start) return null;

  return {
    kickoffIso:  start.toISOString(),
    leagueId:    game?.leagueId    || null,
    leagueName:  game?.league      || null,
    leagueRegion: game?.leagueRegion || null,
    venue:       game?.venue?.name || null,
    homeTeam:    game?.homeTeam?.name || null,
    awayTeam:    game?.awayTeam?.name || null,
  };
}

async function getInsightContext(prop, game) {
  if (!game) return { matchContext: null, teamContext: null };

  try {
    const start    = _safeDate(game.startTime);
    if (!start) return { matchContext: null, teamContext: null };

    const homeName = game?.homeTeam?.name || null;
    const awayName = game?.awayTeam?.name || null;
    const leagueId = game?.leagueId       || null;

    const [homeForm, awayForm] = await Promise.all([
      _teamRecentForm(homeName, leagueId, start),
      _teamRecentForm(awayName, leagueId, start),
    ]);

    return {
      matchContext: _buildMatchContext(game),
      teamContext: {
        homeTeamName:        homeName,
        awayTeamName:        awayName,
        homeForm,
        awayForm,
      },
    };
  } catch (err) {
    logger.warn('[SoccerInsightPipeline] context failed (non-fatal)', { error: err.message });
    return { matchContext: null, teamContext: null };
  }
}

module.exports = { getInsightContext };

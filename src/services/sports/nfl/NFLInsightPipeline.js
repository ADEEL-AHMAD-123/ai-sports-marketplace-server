/**
 * NFLInsightPipeline.js — NFL-specific insight context enrichment
 *
 * Adds lightweight context used by NFL prompting:
 *  - kickoff context (weekend / prime window)
 *  - short-rest and rest-edge signal per team
 *  - recent team form (points for/against from recent finals)
 */

const { Game, GAME_STATUS } = require('../../../models/Game.model');
const logger = require('../../../config/logger');

const RECENT_GAMES = 6;

const _toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const _safeDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};

async function _teamRecentForm(teamName, beforeTime) {
  if (!teamName || !beforeTime) return null;

  const rows = await Game.find({
    sport: 'nfl',
    status: GAME_STATUS.FINAL,
    startTime: { $lt: beforeTime },
    $or: [{ 'homeTeam.name': teamName }, { 'awayTeam.name': teamName }],
  })
    .sort({ startTime: -1 })
    .limit(RECENT_GAMES)
    .select('homeTeam.name awayTeam.name score startTime')
    .lean();

  if (!rows.length) return null;

  let pointsFor = 0;
  let pointsAgainst = 0;

  for (const g of rows) {
    const homePts = _toNum(g?.score?.home);
    const awayPts = _toNum(g?.score?.away);
    if (homePts == null || awayPts == null) continue;

    const isHome = g?.homeTeam?.name === teamName;
    pointsFor += isHome ? homePts : awayPts;
    pointsAgainst += isHome ? awayPts : homePts;
  }

  const count = rows.length;
  return {
    games: count,
    pointsForPerGame: count ? Number((pointsFor / count).toFixed(1)) : null,
    pointsAgainstPerGame: count ? Number((pointsAgainst / count).toFixed(1)) : null,
  };
}

async function _teamRestDays(teamName, beforeTime) {
  if (!teamName || !beforeTime) return null;

  const prev = await Game.findOne({
    sport: 'nfl',
    startTime: { $lt: beforeTime },
    $or: [{ 'homeTeam.name': teamName }, { 'awayTeam.name': teamName }],
  })
    .sort({ startTime: -1 })
    .select('startTime')
    .lean();

  const prevStart = _safeDate(prev?.startTime);
  if (!prevStart) return null;

  const ms = beforeTime.getTime() - prevStart.getTime();
  return Number((ms / (1000 * 60 * 60 * 24)).toFixed(1));
}

function _buildGameContext(game) {
  const start = _safeDate(game?.startTime);
  if (!start) return null;

  const utcHour = start.getUTCHours();
  const utcDay = start.getUTCDay(); // 0 sun ... 6 sat

  const isWeekend = utcDay === 0 || utcDay === 6;
  const isPrimeWindowUtc = (utcHour >= 0 && utcHour <= 3) || (utcHour >= 17 && utcHour <= 21);

  return {
    kickoffIso: start.toISOString(),
    isWeekend,
    isPrimeWindowUtc,
  };
}

async function getInsightContext(prop, game) {
  if (!game) return { gameContext: null, teamContext: null };

  try {
    const start = _safeDate(game.startTime);
    if (!start) return { gameContext: null, teamContext: null };

    const homeName = game?.homeTeam?.name || null;
    const awayName = game?.awayTeam?.name || null;

    const [homeForm, awayForm, homeRestDays, awayRestDays] = await Promise.all([
      _teamRecentForm(homeName, start),
      _teamRecentForm(awayName, start),
      _teamRestDays(homeName, start),
      _teamRestDays(awayName, start),
    ]);

    const restEdge =
      homeRestDays != null && awayRestDays != null
        ? (homeRestDays - awayRestDays).toFixed(1)
        : null;

    return {
      gameContext: _buildGameContext(game),
      teamContext: {
        homeTeamName: homeName,
        awayTeamName: awayName,
        homeForm,
        awayForm,
        homeRestDays,
        awayRestDays,
        restEdgeDays: restEdge != null ? Number(restEdge) : null,
        hasShortRest: (homeRestDays != null && homeRestDays < 6) || (awayRestDays != null && awayRestDays < 6),
      },
    };
  } catch (err) {
    logger.warn('[NFLInsightPipeline] context failed (non-fatal)', { error: err.message });
    return { gameContext: null, teamContext: null };
  }
}

module.exports = { getInsightContext };

/**
 * NFLInsightPipeline.js — NFL-specific insight context enrichment
 *
 * Adds lightweight context used by NFL prompting:
 *  - kickoff context (weekend / prime window)
 *  - short-rest and rest-edge signal per team
 *  - recent team form (points for/against from recent finals)
 */

const TeamGameResult = require('../../../models/TeamGameResult.model');
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

  // Reads TeamGameResult (durable) rather than Game (deleted ~30h after
  // kickoff) so a weekly sport like the NFL actually has history to average.
  const rows = await TeamGameResult.find({
    sport: 'nfl',
    startTime: { $lt: beforeTime },
    $or: [{ homeTeamName: teamName }, { awayTeamName: teamName }],
  })
    .sort({ startTime: -1 })
    .limit(RECENT_GAMES)
    .select('homeTeamName awayTeamName homeScore awayScore startTime')
    .lean();

  if (!rows.length) return null;

  let pointsFor = 0;
  let pointsAgainst = 0;
  let counted = 0;

  for (const g of rows) {
    const homePts = _toNum(g?.homeScore);
    const awayPts = _toNum(g?.awayScore);
    if (homePts == null || awayPts == null) continue;

    const isHome = g.homeTeamName === teamName;
    pointsFor += isHome ? homePts : awayPts;
    pointsAgainst += isHome ? awayPts : homePts;
    counted += 1;
  }

  // Average only over rows with valid scores — never divide by skipped rows.
  if (!counted) return null;
  return {
    games: counted,
    pointsForPerGame: Number((pointsFor / counted).toFixed(1)),
    pointsAgainstPerGame: Number((pointsAgainst / counted).toFixed(1)),
  };
}

async function _teamRestDays(teamName, beforeTime) {
  if (!teamName || !beforeTime) return null;

  const prev = await TeamGameResult.findOne({
    sport: 'nfl',
    startTime: { $lt: beforeTime },
    $or: [{ homeTeamName: teamName }, { awayTeamName: teamName }],
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

    // Omit teamContext entirely when there is no real history yet (e.g. a new
    // setup before TeamGameResult has accumulated games) — the prompt builder
    // then skips the matchup block instead of emitting a misleading "n/a" wall.
    const hasTeamData =
      !!homeForm || !!awayForm || homeRestDays != null || awayRestDays != null;

    return {
      gameContext: _buildGameContext(game),
      teamContext: hasTeamData
        ? {
            homeTeamName: homeName,
            awayTeamName: awayName,
            homeForm,
            awayForm,
            homeRestDays,
            awayRestDays,
            restEdgeDays: restEdge != null ? Number(restEdge) : null,
            hasShortRest: (homeRestDays != null && homeRestDays < 6) || (awayRestDays != null && awayRestDays < 6),
          }
        : null,
    };
  } catch (err) {
    logger.warn('[NFLInsightPipeline] context failed (non-fatal)', { error: err.message });
    return { gameContext: null, teamContext: null };
  }
}

module.exports = { getInsightContext };

/**
 * NBAFormulas.js — NBA stat processing
 *
 * DATA SOURCE: API-Sports NBA v2 (v2.nba.api-sports.io)
 * All fields are FLAT (v2 format, not nested like v1):
 *   points, fgm, fga, ftm, fta, tpm, tpa,
 *   totReb, offReb, defReb, assists, turnovers,
 *   steals, blocks, pFouls, plusMinus,
 *   min (MM:SS string)
 *
 * THREE-WINDOW MODEL:
 *  FORM     (last 5g pts/threes, 8g reb/ast) → hot/cold + variance signal
 *  EDGE     (last 10g)                        → primary signal driving edge%
 *  BASELINE (last 30g)                        → book's pricing reference
 *
 * ADVANCED METRICS:
 *  TS%  = Points / (2 × (FGA + 0.44 × FTA))
 *  eFG% = (FGM + 0.5 × 3PM) / FGA
 *  USG% ≈ (FGA + 0.44×FTA + TOV) / (MIN × 2.083) × 100
 *
 * SESSION 1 IMPROVEMENT:
 *  Playoff/context detection injected into buildNBAPrompt.
 *  Playoff games have different usage patterns — star players spike,
 *  role players may get reduced minutes. AI is explicitly told to
 *  weight form window over baseline when in playoff context.
 */

const logger = require('../../../config/logger');
const { FORM_WINDOW, EDGE_WINDOW, BASELINE_WINDOW } = require('../../../config/constants');
const { buildGameContextPromptBlock } = require('../../shared/gameContext');
const { buildDefensiveContextBlock } = require('./NBADefensiveStatsService');

const STAT_FORM_WINDOWS = {
  points:   5,
  threes:   5,
  rebounds: 8,
  assists:  8,
};

const parseMinutes = (minStr) => {
  if (!minStr) return 0;
  const parts = String(minStr).split(':');
  return parts.length === 2
    ? parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60
    : parseFloat(String(minStr)) || 0;
};

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const avg = (val, count) => count > 0 ? parseFloat((val / count).toFixed(1)) : 0;

// Standard deviation — used for minute-share variance filter (Session 8)
const stdDev = (values) => {
  if (!values?.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const applyNBAFormulas = (rawStats, statType = 'points') => {
  if (!rawStats?.length) {
    logger.warn('[NBAFormulas] No stats provided');
    return {};
  }

  const formWindow    = STAT_FORM_WINDOWS[statType] ?? FORM_WINDOW;
  const formGames     = rawStats.slice(-formWindow);
  const edgeGames     = rawStats.slice(-EDGE_WINDOW);
  const baselineGames = rawStats.slice(-BASELINE_WINDOW);

  const sum = (games) => games.reduce((acc, g) => {
    acc.pts += n(g.points);
    acc.fgm += n(g.fgm);
    acc.fga += n(g.fga);
    acc.ftm += n(g.ftm);
    acc.fta += n(g.fta);
    acc.tpm += n(g.tpm);
    acc.tpa += n(g.tpa);
    acc.reb += n(g.totReb);
    acc.ast += n(g.assists);
    acc.tov += n(g.turnovers);
    acc.min += parseMinutes(g.min);
    acc.pm  += n(typeof g.plusMinus === 'string' ? parseFloat(g.plusMinus) : g.plusMinus);
    return acc;
  }, { pts:0, fgm:0, fga:0, ftm:0, fta:0, tpm:0, tpa:0, reb:0, ast:0, tov:0, min:0, pm:0 });

  const fT = sum(formGames);
  const eT = sum(edgeGames);
  const bT = sum(baselineGames);
  const fC = formGames.length || 1;
  const eC = edgeGames.length || 1;
  const bC = baselineGames.length || 1;

  const hasFullFormWindow     = formGames.length >= formWindow;
  const hasFullEdgeWindow     = edgeGames.length >= EDGE_WINDOW;
  const hasFullBaselineWindow = baselineGames.length >= BASELINE_WINDOW;

  // Form averages
  const formPoints   = avg(fT.pts, fC);
  const formRebounds = avg(fT.reb, fC);
  const formAssists  = avg(fT.ast, fC);
  const formThrees   = avg(fT.tpm, fC);
  const formMinutes  = avg(fT.min, fC);

  // ── Minute-share variance filter (Session 8) ──────────────────────────────
  // Players with wildly inconsistent minutes (foul trouble, rotation changes)
  // produce misleading stat averages. stdDev(min)/mean > 0.35 = unreliable.
  // Example: Isaiah Stewart 32min one game, 14min the next → avg is noise.
  const edgeMinuteValues = edgeGames.map(g => parseMinutes(g.min)).filter(m => m > 0);
  const meanMinutes      = edgeMinuteValues.length
    ? edgeMinuteValues.reduce((s, v) => s + v, 0) / edgeMinuteValues.length : 0;
  const minuteStdDev     = stdDev(edgeMinuteValues);
  const minuteCV         = meanMinutes > 0 ? minuteStdDev / meanMinutes : 0; // coefficient of variation
  const hasInconsistentMinutes = minuteCV > 0.35 && edgeMinuteValues.length >= 5;

  // Edge averages (primary signal)
  const avgPoints    = avg(eT.pts, eC);
  const avgRebounds  = avg(eT.reb, eC);
  const avgAssists   = avg(eT.ast, eC);
  const avgThrees    = avg(eT.tpm, eC);
  const avgMinutes   = avg(eT.min, eC);
  const avgPlusMinus = avg(eT.pm,  eC);

  // Baseline averages
  const baselinePoints   = avg(bT.pts, bC);
  const baselineRebounds = avg(bT.reb, bC);
  const baselineAssists  = avg(bT.ast, bC);
  const baselineThrees   = avg(bT.tpm, bC);
  const baselineMinutes  = avg(bT.min, bC);

  // Advanced metrics (baseline window)
  const tsDenom = 2 * (bT.fga + 0.44 * bT.fta);
  const trueShootingPct = tsDenom > 0 && bT.pts > 0
    ? parseFloat(((bT.pts / tsDenom) * 100).toFixed(1)) : null;

  const effectiveFGPct = bT.fga > 0
    ? parseFloat((((bT.fgm + 0.5 * bT.tpm) / bT.fga) * 100).toFixed(1)) : null;

  const avgFGA = avg(eT.fga, eC);
  const avgFTA = avg(eT.fta, eC);
  const avgTOV = avg(eT.tov, eC);
  const PACE_PER_MIN = 100 / 48;
  const usgRaw = avgMinutes > 0
    ? ((avgFGA + 0.44 * avgFTA + avgTOV) / (avgMinutes * PACE_PER_MIN)) * 100 : 0;
  const approxUSGPct = (usgRaw > 0 && usgRaw <= 45)
    ? parseFloat(usgRaw.toFixed(1)) : null;

  const recentStatValues = formGames.map((g) => ({
    points:         n(g.points),
    rebounds:       n(g.totReb),
    assists:        n(g.assists),
    threes:         n(g.tpm),
    points_assists: n(g.points) + n(g.assists),
  }[statType] ?? 0));

  // Combined pts+ast — sum of both averages
  const avgPointsAssists         = parseFloat((avgPoints     + avgAssists).toFixed(1));
  const baselinePointsAssists    = parseFloat((baselinePoints + baselineAssists).toFixed(1));
  const formPointsAssists        = parseFloat((formPoints    + formAssists).toFixed(1));

  const focusMap = {
    points: avgPoints, rebounds: avgRebounds, assists: avgAssists, threes: avgThrees,
    points_assists: avgPointsAssists,
  };
  const baseMap  = {
    points: baselinePoints, rebounds: baselineRebounds, assists: baselineAssists, threes: baselineThrees,
    points_assists: baselinePointsAssists,
  };

  if (!(statType in focusMap)) {
    logger.warn(`[NBAFormulas] Unknown statType "${statType}" — skipping`);
    return {};
  }

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }

  return {
    formPoints, formRebounds, formAssists, formThrees, formMinutes,
    formPointsAssists,
    formGamesCount: fC,
    hasFullFormWindow,
    avgPoints, avgRebounds, avgAssists, avgThrees, avgMinutes, avgPlusMinus,
    edgeGamesCount: eC,
    hasFullEdgeWindow,
    baselinePoints, baselineRebounds, baselineAssists, baselineThrees, baselineMinutes,
    baselineGamesCount: bC,
    hasFullBaselineWindow,
    trueShootingPct, effectiveFGPct, approxUSGPct,
    recentStatValues,
    gamesAnalyzed: formGames.length,
    dataQuality,
    hasInconsistentMinutes,  // true when minuteCV > 0.35 — forces 'low' AI confidence
    minuteCV: parseFloat(minuteCV.toFixed(2)),
    focusStat:       statType,
    focusStatAvg:    focusMap[statType],
    baselineStatAvg: baseMap[statType],
    dataType: 'game_log',
  };
};

/**
 * Build NBA AI prompt.
 *
 * @param {Object} params
 * @param {Object} params.processedStats - Output of applyNBAFormulas()
 * @param {string} params.playerName
 * @param {string} params.statType
 * @param {number} params.bettingLine
 * @param {string} params.injuryContext  - From injuryService.getInjuryPromptContext()
 * @param {Object} params.gameContext    - Output of detectNBAGameContext() — SESSION 1 ADDITION
 */
const buildNBAPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  injuryContext    = '',
  gameContext      = null,   // { isPlayoff, gameNumber, round, seriesContext }
  defensiveContext = null,   // { homeTeamDef, awayTeamDef } — SESSION 3
}) => {
  const {
    formGamesCount=5, edgeGamesCount=10, baselineGamesCount=30,
    hasFullFormWindow=false, hasFullEdgeWindow=false, hasFullBaselineWindow=false,
    focusStatAvg='N/A', baselineStatAvg='N/A',
    formPoints='N/A', formRebounds='N/A', formAssists='N/A', formThrees='N/A',
    formPointsAssists='N/A',
    formMinutes='N/A', avgMinutes='N/A', baselineMinutes='N/A',
    avgPlusMinus=null,
    recentStatValues=[],
    trueShootingPct=null, effectiveFGPct=null, approxUSGPct=null,
    dataQuality='moderate',
  } = s;

  const statLabel = {
    points: 'Points', rebounds: 'Total Rebounds',
    assists: 'Assists', threes: '3-Pointers Made',
    points_assists: 'Pts+Ast Combined',
  }[statType] || statType;

  const formStat = {
    points:         formPoints,
    rebounds:       formRebounds,
    assists:        formAssists,
    threes:         formThrees,
    points_assists: formPointsAssists ?? 'N/A',
  }[statType] ?? 'N/A';

  const recentStr  = recentStatValues.length ? recentStatValues.join(', ') : 'No data';
  const signal     = parseFloat(focusStatAvg) > parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  // Trend: form vs baseline delta
  const formNum     = parseFloat(formStat);
  const baselineNum = parseFloat(baselineStatAvg);
  const trendPct    = (formNum > 0 && baselineNum > 0)
    ? Math.round((formNum - baselineNum) / baselineNum * 100) : null;
  const trendStr = trendPct !== null && Math.abs(trendPct) >= 15
    ? ` ⚠️ TREND: ${trendPct > 0 ? '+' : ''}${trendPct}% vs baseline` : '';

  // Session 8: minute-variance warning
  const minuteWarning = s.hasInconsistentMinutes
    ? `\n⚠️ INCONSISTENT MINUTES: CV=${s.minuteCV} (>0.35 threshold). Player has erratic playing time — stat averages are unreliable. Force confidence: LOW regardless of edge signal.`
    : '';

  // Plus/minus context
  const pmStr = avgPlusMinus !== null
    ? ` | +/-: ${avgPlusMinus > 0 ? '+' : ''}${avgPlusMinus}` : '';

  // Playoff context block — the SESSION 1 key addition
  const playoffBlock = gameContext
    ? buildGameContextPromptBlock(gameContext, { sport: 'nba' })
    : '';

  const formTargetWindow  = STAT_FORM_WINDOWS[statType] ?? FORM_WINDOW;
  const edgeTargetWindow  = EDGE_WINDOW;
  const baselineTarget    = BASELINE_WINDOW;

  // Session 3: defensive context block
  const defBlock = defensiveContext
    ? buildDefensiveContextBlock(statType, defensiveContext.homeTeamDef, defensiveContext.awayTeamDef)
    : '';

  return `You are an expert NBA prop betting analyst. Respond with ONLY a JSON object.

PLAYER: ${playerName} | STAT: ${statLabel} | LINE: ${bettingLine}
SIGNAL: ${signal} (10-game avg ${focusStatAvg} vs line ${bettingLine})
${playoffBlock ? `\n${playoffBlock}\n` : ''}${defBlock ? `\n${defBlock}\n` : ''}${minuteWarning}
THREE-WINDOW ANALYSIS:
  FORM     (${formGamesCount}/${formTargetWindow}g, ${hasFullFormWindow ? 'COMPLETE' : 'PARTIAL'}): avg ${formStat}, min/g ${formMinutes}${trendStr}
  EDGE     (${edgeGamesCount}/${edgeTargetWindow}g, ${hasFullEdgeWindow ? 'COMPLETE' : 'PARTIAL'}): avg ${focusStatAvg}, min/g ${avgMinutes}${pmStr}  ← PRIMARY
  BASELINE (${baselineGamesCount}/${baselineTarget}g, ${hasFullBaselineWindow ? 'COMPLETE' : 'PARTIAL'}): avg ${baselineStatAvg}, min/g ${baselineMinutes}
  GAME LOG (last ${formGamesCount}g): ${recentStr}
  EFFICIENCY: TS% ${trueShootingPct ?? 'N/A'}% | eFG% ${effectiveFGPct ?? 'N/A'}% | USG% ${approxUSGPct ?? 'N/A'}%
${injuryContext ? `\n  INJURY: ${injuryContext}` : ''}

ANALYST RULES:
  - PRIMARY signal = 10-game avg vs line
  - If ⚠️ PLAYOFF CONTEXT: weight FORM window over BASELINE — role/usage has changed
  - If ⚠️ TREND: form shifted >15% from baseline — role or matchup has changed, weight FORM
  - OPPONENT DEFENSE: 🔴 POOR = favor OVER on that stat | 🟢 STRONG = favor UNDER
  - Defensive matchup is a MODIFIER not the primary signal — use it to confirm or flip edge picks
  - If ⚠️ INCONSISTENT MINUTES: force "low" confidence — minutes CV > 0.35 makes avg unreliable
  - If game log shows high variance (e.g. 0,28,3,31,2) → confidence "low" regardless of avg
  - If +/- is consistently negative (<-3) → player is in disadvantaged matchups
  - dataQuality "weak" if any window is PARTIAL and edge is <10g, "strong" if all COMPLETE

Return exactly:
{"recommendation":"over"|"under","confidence":"low"|"medium"|"high","summary":"≤25 words citing key number","factors":["specific window + number","second data point","efficiency or role context"],"risks":["primary risk that could flip the pick"],"dataQuality":"strong"|"moderate"|"weak"}`;
};

module.exports = { applyNBAFormulas, buildNBAPrompt, parseMinutes };


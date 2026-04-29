/**
 * NHLFormulas.js — NHL stat processing
 *
 * DATA SOURCE: API-Sports Hockey v1 (v1.hockey.api-sports.io)
 *   Same API key as NBA/MLB. Free tier: 100 requests/day.
 *   No team param required — search by player name works.
 *
 * GAME LOG STAT FIELDS (from /players/statistics):
 *   goals, assists, points (goals+assists), shots, penaltyMinutes,
 *   plusMinus, timeOnIce (MM:SS), powerPlayGoals, shortHandedGoals,
 *   saves, goalsAgainst, savePercentage (goalies only)
 *
 * WINDOWS:
 *   FORM     = last 5 games  (current hot/cold streak)
 *   EDGE     = last 10 games (primary signal vs line)
 *   BASELINE = last 30 games (season context)
 *
 * NHL SIGNAL RELIABILITY:
 *   shots_on_goal — most consistent, ~4-5 per game for top forwards
 *   points (g+a)  — moderate variance, boosted in PP situations
 *   goals         — high variance (top scorers average ~0.4-0.5/game)
 *   assists       — moderate, playmakers more consistent than goal scorers
 */

const NHL_FORM_WINDOW     = 5;
const NHL_EDGE_WINDOW     = 10;
const NHL_BASELINE_WINDOW = 30;

const n   = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const avg = (val, count) => count > 0 ? parseFloat((val / count).toFixed(2)) : 0;

// Parse MM:SS time on ice string → decimal minutes
const parseTOI = (toi = '') => {
  if (!toi) return 0;
  const parts = String(toi).split(':');
  return parseInt(parts[0], 10) + (parseInt(parts[1] || '0', 10) / 60);
};

const applyNHLFormulas = (rawStats, statType = 'shots_on_goal') => {
  if (!rawStats?.length) return {};

  const formGames     = rawStats.slice(-NHL_FORM_WINDOW);
  const edgeGames     = rawStats.slice(-NHL_EDGE_WINDOW);
  const baselineGames = rawStats.slice(-NHL_BASELINE_WINDOW);

  const sumNHL = (games) => games.reduce((acc, g) => {
    acc.goals   += n(g.goals);
    acc.assists += n(g.assists);
    acc.points  += n(g.goals) + n(g.assists); // pts = g + a
    acc.shots   += n(g.shots) || n(g.shotsOnGoal) || n(g.sog);
    acc.toi     += parseTOI(g.timeOnIce || g.toi);
    acc.pim     += n(g.penaltyMinutes) || n(g.pim);
    acc.games++;
    return acc;
  }, { goals: 0, assists: 0, points: 0, shots: 0, toi: 0, pim: 0, games: 0 });

  const fS = sumNHL(formGames);
  const eS = sumNHL(edgeGames);
  const bS = sumNHL(baselineGames);
  const fC = fS.games || 1;
  const eC = eS.games || 1;
  const bC = bS.games || 1;

  const goalsPerG   = avg(eS.goals,   eC);
  const assistsPerG = avg(eS.assists, eC);
  const pointsPerG  = avg(eS.points,  eC);
  const shotsPerG   = avg(eS.shots,   eC);
  const toiPerG     = avg(eS.toi,     eC);

  const focusMap = {
    goals:         goalsPerG,
    assists:       assistsPerG,
    points:        pointsPerG,
    shots_on_goal: shotsPerG,
  };

  const baseMap = {
    goals:         avg(bS.goals,   bC),
    assists:       avg(bS.assists, bC),
    points:        avg(bS.points,  bC),
    shots_on_goal: avg(bS.shots,   bC),
  };

  const formMap = {
    goals:         avg(fS.goals,   fC),
    assists:       avg(fS.assists, fC),
    points:        avg(fS.points,  fC),
    shots_on_goal: avg(fS.shots,   fC),
  };

  const focusStatAvg    = focusMap[statType] ?? shotsPerG;
  const baselineStatAvg = baseMap[statType]  ?? avg(bS.shots, bC);
  const formStatAvg     = formMap[statType]  ?? avg(fS.shots, fC);

  const recentStatValues = formGames.map(g => ({
    goals:         n(g.goals),
    assists:       n(g.assists),
    points:        n(g.goals) + n(g.assists),
    shots_on_goal: n(g.shots) || n(g.shotsOnGoal) || n(g.sog),
  }[statType] ?? 0));

  const hasFullFormWindow     = formGames.length  >= NHL_FORM_WINDOW;
  const hasFullEdgeWindow     = edgeGames.length  >= NHL_EDGE_WINDOW;
  const hasFullBaselineWindow = baselineGames.length >= NHL_BASELINE_WINDOW;

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }

  return {
    goalsPerG, assistsPerG, pointsPerG, shotsPerG, toiPerG,
    formGoals:   avg(fS.goals,   fC),
    formAssists: avg(fS.assists, fC),
    formPoints:  avg(fS.points,  fC),
    formShots:   avg(fS.shots,   fC),
    formStatAvg,
    focusStat:          statType,
    focusStatAvg:       parseFloat(focusStatAvg.toFixed(2)),
    baselineStatAvg:    parseFloat(baselineStatAvg.toFixed(2)),
    edgeGamesCount:     eC,
    formGamesCount:     fC,
    baselineGamesCount: bC,
    recentStatValues,
    gamesAnalyzed:      formGames.length,
    hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow,
    dataQuality,
    dataType: 'game_log',
  };
};

// ─── AI Prompt ────────────────────────────────────────────────────────────────

const buildNHLPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  injuryContext = '',
}) => {
  const label = {
    goals:         'Goals',
    assists:       'Assists',
    points:        'Points (G+A)',
    shots_on_goal: 'Shots on Goal',
  }[statType] || statType;

  const focusAvg = parseFloat(s.focusStatAvg) || 0;
  const signal   = focusAvg >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  const formAvg  = parseFloat(s.formStatAvg ?? 0);
  const baseAvg  = parseFloat(s.baselineStatAvg ?? 0);
  const trendPct = (formAvg > 0 && baseAvg > 0)
    ? Math.round((formAvg - baseAvg) / baseAvg * 100) : null;
  const trendStr = trendPct !== null && Math.abs(trendPct) >= 20
    ? ` ⚠️ TREND: ${trendPct > 0 ? '+' : ''}${trendPct}% vs baseline` : '';

  const recent = (s.recentStatValues || []).join(', ') || 'N/A';

  return `You are an expert NHL prop betting analyst. Respond with ONLY a JSON object.

PLAYER: ${playerName} | STAT: ${label} | LINE: ${bettingLine}
SIGNAL: ${signal} (${s.edgeGamesCount ?? 10}-game avg ${focusAvg} vs line ${bettingLine})

THREE-WINDOW ANALYSIS:
  FORM     (last ${s.formGamesCount ?? 5}g): ${label}=${s.formStatAvg ?? 'N/A'}${trendStr}
  EDGE     (last ${s.edgeGamesCount ?? 10}g): ${label}=${focusAvg} | Goals/g=${s.goalsPerG ?? 'N/A'} | Assists/g=${s.assistsPerG ?? 'N/A'} | Shots/g=${s.shotsPerG ?? 'N/A'} | TOI=${s.toiPerG ?? 'N/A'}min  ← PRIMARY
  BASELINE (last ${s.baselineGamesCount ?? 30}g): ${label}=${s.baselineStatAvg ?? 'N/A'}
  RECENT ${label.toUpperCase()} (last ${s.formGamesCount ?? 5}g): ${recent}
${injuryContext ? `\nSTATUS: ${injuryContext}` : ''}

ANALYST RULES:
  - PRIMARY signal = ${s.edgeGamesCount ?? 10}-game avg vs line
  - If ⚠️ TREND: form shifted >20% from baseline — weight FORM window
  - Shots on goal most consistent; goals high-variance — lower confidence
  - Playoff hockey: pace slows, lines tighten — account for defensive intensity
  - Partial windows [PARTIAL] → lean "moderate" confidence

Return exactly:
{"recommendation":"over"|"under","confidence":"low"|"medium"|"high","summary":"≤25 words citing key number","factors":["specific stat + window","second point","third"],"risks":["primary risk"],"dataQuality":"strong"|"moderate"|"weak"}`;
};

module.exports = { applyNHLFormulas, buildNHLPrompt };
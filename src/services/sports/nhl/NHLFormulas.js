/**
 * NHLFormulas.js — NHL stat processing + AI prompt builder
 *
 * DATA SOURCE: API-Sports Hockey v1
 *   Fields per game: goals, assists, shots (=SOG), penaltyMinutes,
 *   plusMinus, timeOnIce (MM:SS), powerPlayGoals
 *
 * THREE-WINDOW MODEL:
 *   FORM     = last 5 games  → current hot/cold streak
 *   EDGE     = last 10 games → primary signal vs line (same as NBA/MLB)
 *   BASELINE = last 30 games → season-level context
 *
 * NHL-SPECIFIC METRICS:
 *   TOI variance (CV)    — inconsistent ice time = unreliable averages
 *   PP rate              — powerPlayGoals/game tells PP-unit contribution
 *   Shooting efficiency  — goals / shots (finishing quality)
 *   Scoring streak       — goals in last 5 vs last 10 (slump/streak detection)
 *
 * GOALIE/TEAM CONTEXT is injected via NHLInsightPipeline → buildNHLPrompt()
 * — these are passed in as parameters, not computed here.
 */

const NHL_FORM_WINDOW     = 5;
const NHL_EDGE_WINDOW     = 10;
const NHL_BASELINE_WINDOW = 30;

const n   = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const avg = (val, cnt) => cnt > 0 ? parseFloat((val / cnt).toFixed(2)) : 0;

// Parse MM:SS or decimal TOI string → decimal minutes
const parseTOI = (toi = '') => {
  if (!toi) return 0;
  const s = String(toi);
  if (s.includes(':')) {
    const [mm, ss] = s.split(':');
    return parseInt(mm, 10) + (parseInt(ss || '0', 10) / 60);
  }
  return parseFloat(s) || 0;
};

// Standard deviation for TOI variance check
const stdDev = (values) => {
  if (!values?.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

/**
 * applyNHLFormulas — compute all stats windows + metrics from raw game log
 *
 * @param {Array} rawStats — normalized game log rows from NHLAdapter
 * @param {string} statType — 'shots_on_goal' | 'goals' | 'assists' | 'points'
 * @returns {Object} processedStats passed to buildNHLPrompt + StrategyService
 */
const applyNHLFormulas = (rawStats, statType = 'shots_on_goal') => {
  if (!rawStats?.length) return {};

  const formGames     = rawStats.slice(-NHL_FORM_WINDOW);
  const edgeGames     = rawStats.slice(-NHL_EDGE_WINDOW);
  const baselineGames = rawStats.slice(-NHL_BASELINE_WINDOW);

  // ── Sum all counting stats across a window ────────────────────────────────
  const sumWindow = (games) => games.reduce((acc, g) => {
    acc.goals   += n(g.goals);
    acc.assists += n(g.assists);
    acc.points  += n(g.goals) + n(g.assists);
    acc.shots   += n(g.shots) || n(g.shotsOnGoal) || n(g.sog);
    acc.ppg     += n(g.powerPlayGoals) || n(g.ppg) || 0;
    acc.pim     += n(g.penaltyMinutes) || n(g.pim);
    acc.pm      += n(g.plusMinus) || n(g.pm);
    acc.toi     += parseTOI(g.timeOnIce || g.toi || '');
    acc.games++;
    return acc;
  }, { goals: 0, assists: 0, points: 0, shots: 0, ppg: 0, pim: 0, pm: 0, toi: 0, games: 0 });

  const fS = sumWindow(formGames);
  const eS = sumWindow(edgeGames);
  const bS = sumWindow(baselineGames);
  const fC = fS.games || 1;
  const eC = eS.games || 1;
  const bC = bS.games || 1;

  // ── Edge window averages (primary signal) ─────────────────────────────────
  const goalsPerG   = avg(eS.goals,   eC);
  const assistsPerG = avg(eS.assists, eC);
  const pointsPerG  = avg(eS.points,  eC);
  const shotsPerG   = avg(eS.shots,   eC);
  const toiPerG     = avg(eS.toi,     eC);
  const ppgPerG     = avg(eS.ppg,     eC);  // power play goals per game

  // ── TOI variance filter (NHL equivalent of NBA minute variance) ───────────
  const edgeTOIValues = edgeGames.map(g => parseTOI(g.timeOnIce || g.toi || '')).filter(t => t > 0);
  const meanTOI        = edgeTOIValues.length
    ? edgeTOIValues.reduce((s, v) => s + v, 0) / edgeTOIValues.length : 0;
  const toiStdDev      = stdDev(edgeTOIValues);
  const toiCV          = meanTOI > 0 ? toiStdDev / meanTOI : 0;
  // CV > 0.30 = inconsistent ice time → averages less reliable
  const hasInconsistentTOI = toiCV > 0.30 && edgeTOIValues.length >= 5;

  // ── PP rate — are stats PP-dependent? ────────────────────────────────────
  // If >40% of goals came on PP, player is highly PP-dependent
  // PP-dependent players are more variable (PP time can change game to game)
  const ppDependencyPct = eS.goals > 0
    ? parseFloat(((eS.ppg / eS.goals) * 100).toFixed(0))
    : 0;
  const isPPDependent = ppDependencyPct > 40;

  // ── Shooting efficiency (for goals + shots context) ───────────────────────
  // goals / shots = finishing rate. High finisher with low shots can still score.
  const shootingPct = eS.shots > 0
    ? parseFloat(((eS.goals / eS.shots) * 100).toFixed(1))
    : null;

  // ── Scoring streak detection ──────────────────────────────────────────────
  const formGoals    = fS.goals;   // goals in last 5
  const edgeGoals    = eS.goals;   // goals in last 10
  // If form is significantly above or below pace
  const formGoalRate = avg(fS.goals,  fC);
  const edgeGoalRate = avg(eS.goals,  eC);
  const onGoalStreak = formGoalRate >= edgeGoalRate * 1.5 && formGoalRate > 0;
  const onGoalSlump  = formGoalRate === 0 && edgeGoalRate > 0.2; // 0 in last 5 but normally scores

  // ── Recent stat values (for StrategyService confidence scoring) ───────────
  const recentStatValues = formGames.map(g => ({
    goals:         n(g.goals),
    assists:       n(g.assists),
    points:        n(g.goals) + n(g.assists),
    shots_on_goal: n(g.shots) || n(g.shotsOnGoal) || n(g.sog),
  }[statType] ?? 0));

  // ── Focus stat maps (edge + baseline + form) ─────────────────────────────
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

  // ── Data completeness ─────────────────────────────────────────────────────
  const hasFullFormWindow     = formGames.length     >= NHL_FORM_WINDOW;
  const hasFullEdgeWindow     = edgeGames.length     >= NHL_EDGE_WINDOW;
  const hasFullBaselineWindow = baselineGames.length >= NHL_BASELINE_WINDOW;

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }

  return {
    // Window averages
    goalsPerG, assistsPerG, pointsPerG, shotsPerG, toiPerG, ppgPerG,
    formStatAvg, focusStatAvg: parseFloat(focusStatAvg.toFixed(2)),
    baselineStatAvg:    parseFloat(baselineStatAvg.toFixed(2)),
    formGamesCount:     fC,
    edgeGamesCount:     eC,
    baselineGamesCount: bC,
    hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow,
    recentStatValues,
    gamesAnalyzed: formGames.length,
    dataQuality,
    dataType: 'game_log',

    // NHL-specific metrics
    hasInconsistentTOI,
    toiCV:            parseFloat(toiCV.toFixed(2)),
    ppDependencyPct,
    isPPDependent,
    shootingPct,
    onGoalStreak,
    onGoalSlump,
    formGoals,
    edgeGoals,

    // For StrategyService
    focusStat: statType,
  };
};

// ─── AI Prompt Builder ────────────────────────────────────────────────────────

/**
 * buildNHLPrompt — construct the full AI prompt for one NHL prop
 *
 * @param {Object} params
 * @param {Object} params.processedStats     — output of applyNHLFormulas()
 * @param {string} params.playerName
 * @param {string} params.statType
 * @param {number} params.bettingLine
 * @param {string} [params.injuryContext]    — from NHLInjuryService
 * @param {Object} [params.goalieContext]    — from NHLGoalieService
 * @param {Object} [params.teamContext]      — from NHLTeamStatsService
 * @param {string} [params.playerSide]       — 'home' | 'away' | null
 * @param {boolean}[params.isPlayoff]        — playoff detection flag
 */
const buildNHLPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  injuryContext  = '',
  goalieContext  = null,
  teamContext    = null,
  playerSide     = null,
  isPlayoff      = false,
}) => {
  const label = {
    goals:         'Goals',
    assists:       'Assists',
    points:        'Points (G+A)',
    shots_on_goal: 'Shots on Goal',
  }[statType] || statType;

  const focusAvg = parseFloat(s.focusStatAvg) || 0;
  const signal   = focusAvg >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  // Trend detection (form vs baseline)
  const formAvg  = parseFloat(s.formStatAvg ?? 0);
  const baseAvg  = parseFloat(s.baselineStatAvg ?? 0);
  const trendPct = (formAvg > 0 && baseAvg > 0)
    ? Math.round((formAvg - baseAvg) / baseAvg * 100) : null;
  const trendStr = trendPct !== null && Math.abs(trendPct) >= 20
    ? ` ⚠️ TREND: ${trendPct > 0 ? '+' : ''}${trendPct}% vs baseline` : '';

  // TOI variance warning
  const toiWarning = s.hasInconsistentTOI
    ? `\n⚠️ INCONSISTENT TOI: CV=${s.toiCV} (>0.30). Ice time is erratic — averages are less reliable. Lower confidence.`
    : '';

  // PP dependency note
  const ppNote = s.isPPDependent && s.ppDependencyPct > 0
    ? `\n⚡ PP DEPENDENT: ${s.ppDependencyPct}% of goals on power play. Prop exposed to PP opportunity variance.`
    : '';

  // Streak/slump note
  const streakNote = s.onGoalStreak
    ? `\n🔥 GOAL STREAK: ${s.formGoals} goals in last ${s.formGamesCount}g (above ${s.edgeGamesCount}g pace). Elevated form.`
    : s.onGoalSlump
    ? `\n❄️ GOAL SLUMP: 0 goals in last ${s.formGamesCount}g despite scoring ${s.edgeGoals} in last ${s.edgeGamesCount}g. Regression or slump.`
    : '';

  // Shooting efficiency (only relevant for goals)
  const shootNote = (statType === 'goals' || statType === 'points') && s.shootingPct != null
    ? `\n  Shooting%: ${s.shootingPct}% (goals/shots, last ${s.edgeGamesCount}g)`
    : '';

  // Goalie context block
  let goalieBlock = '';
  if (goalieContext && playerSide) {
    const { buildGoaliePromptBlock } = require('./NHLGoalieService');
    goalieBlock = buildGoaliePromptBlock(playerSide, goalieContext);
  } else if (goalieContext && !playerSide) {
    // Can't determine side — show both goalies
    const homeG = goalieContext.homeGoalie;
    const awayG = goalieContext.awayGoalie;
    if (homeG || awayG) {
      goalieBlock = [
        homeG ? `HOME GOALIE: ${homeG.name || '?'} SV%=${homeG.savePercentage ? (homeG.savePercentage*100).toFixed(1) : '?'} (${homeG.tier || '?'})` : '',
        awayG ? `AWAY GOALIE: ${awayG.name || '?'} SV%=${awayG.savePercentage ? (awayG.savePercentage*100).toFixed(1) : '?'} (${awayG.tier || '?'})` : '',
      ].filter(Boolean).join('\n');
    }
  }

  // Team context block
  let teamBlock = '';
  if (teamContext && playerSide) {
    const { buildTeamContextPromptBlock } = require('./NHLTeamStatsService');
    teamBlock = buildTeamContextPromptBlock(playerSide, teamContext);
  } else if (teamContext?.playoff?.isPlayoff) {
    teamBlock = teamContext.playoff.intensity || '';
  }

  const recent = (s.recentStatValues || []).join(', ') || 'N/A';
  const completeness = [
    !s.hasFullFormWindow ? 'FORM PARTIAL' : null,
    !s.hasFullEdgeWindow ? 'EDGE PARTIAL' : null,
    !s.hasFullBaselineWindow ? 'BASELINE PARTIAL' : null,
  ].filter(Boolean).join(', ') || 'ALL COMPLETE';

  return `You are an expert NHL prop betting analyst. Respond with ONLY a JSON object.

PLAYER: ${playerName} | STAT: ${label} | LINE: ${bettingLine}
SIGNAL: ${signal} (${s.edgeGamesCount ?? NHL_EDGE_WINDOW}-game avg ${focusAvg} vs line ${bettingLine})
${isPlayoff ? '🏒 PLAYOFF GAME — defensive intensity higher, scoring rates 10-15% below regular season' : ''}

${goalieBlock ? `GOALIE MATCHUP:\n${goalieBlock}\n` : ''}${teamBlock ? `\nTEAM CONTEXT:\n${teamBlock}\n` : ''}
THREE-WINDOW ANALYSIS:
  FORM     (last ${s.formGamesCount ?? NHL_FORM_WINDOW}g, ${s.hasFullFormWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${formAvg.toFixed(2)}${trendStr}
  EDGE     (last ${s.edgeGamesCount ?? NHL_EDGE_WINDOW}g, ${s.hasFullEdgeWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${focusAvg} | Goals/g=${s.goalsPerG ?? 'N/A'} | Assists/g=${s.assistsPerG ?? 'N/A'} | SOG/g=${s.shotsPerG ?? 'N/A'} | TOI/g=${s.toiPerG ?? 'N/A'}min  ← PRIMARY${shootNote}
  BASELINE (last ${s.baselineGamesCount ?? NHL_BASELINE_WINDOW}g, ${s.hasFullBaselineWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${baseAvg.toFixed(2)}
  RECENT ${label.toUpperCase()} (last ${s.formGamesCount ?? NHL_FORM_WINDOW}g): ${recent}
  DATA WINDOWS: ${completeness}
${toiWarning}${ppNote}${streakNote}
${injuryContext ? `\nINJURY/STATUS: ${injuryContext}` : ''}

ANALYST RULES:
  - PRIMARY signal = ${s.edgeGamesCount ?? NHL_EDGE_WINDOW}-game avg vs line
  - GOALIE MATCHUP is a strong modifier — elite goalie (SV%>93%) suppresses shots AND goals
  - OPPOSING DEFENSE quality affects all stats — check GA/g and shots-against
  - ⚠️ INCONSISTENT TOI → force "low" confidence regardless of edge signal
  - ⚡ PP DEPENDENT → factor in PP opportunity uncertainty
  - 🏒 PLAYOFF games: scoring is 10-15% lower than regular season — adjust expectations
  - SHOTS on goal is most consistent; GOALS are high variance (even elite scorers go cold)
  - If ⚠️ TREND: form shifted >20% from baseline → weight FORM window over EDGE
  - PARTIAL windows → lean "moderate" or "low" confidence

Return exactly:
{"recommendation":"over"|"under","confidence":"low"|"medium"|"high","summary":"≤25 words citing key number","factors":["goalie/team matchup","form+edge signal","TOI or PP context"],"risks":["primary risk that could flip the pick"],"dataQuality":"strong"|"moderate"|"weak"}`;
};

module.exports = { applyNHLFormulas, buildNHLPrompt, parseTOI };


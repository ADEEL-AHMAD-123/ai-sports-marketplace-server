/**
 * NHLFormulas.js — NHL stat processing + AI prompt builder
 *
 * DATA SOURCE: Official NHL Stats API (api-web.nhle.com/v1)
 *   Per-game fields surfaced by NHLStatsClient.getPlayerGameLog:
 *     goals, assists, points, shots (=SOG), powerPlayGoals, powerPlayPoints,
 *     shortHandedGoals, plusMinus, pim, toi (MM:SS), homeRoadFlag, opponentAbbrev
 *
 * THREE-WINDOW MODEL (per-stat aware):
 *   FORM     = last 5 games (last 8g for goals — high variance)
 *   EDGE     = last 10 games — primary signal vs line
 *   BASELINE = last 30 games — season-level pricing reference
 *
 * NHL-SPECIFIC METRICS:
 *   TOI variance (CV)        — inconsistent ice time = unreliable averages
 *                              threshold differs by position (D have higher
 *                              natural variance than F)
 *   Line tier                — top-6 / middle-6 / bottom-6 from EDGE-window TOI
 *   PP rate                  — powerPlayGoals / total goals (PP-dependence)
 *   Shooting efficiency      — goals / shots (finishing quality)
 *   Scoring streak / slump   — form vs edge goal rate
 *   Plus/minus               — surfaced as line-quality proxy
 *
 * CONTEXT INJECTED VIA NHLInsightPipeline:
 *   goalieContext  — opposing goalie SV%, recent form
 *   teamContext    — PP%, PK%, GA/G, SA/G, expected pace
 *   injuryContext  — text from NHLInjuryService (if any)
 *   playerSide     — 'home' | 'away' for opposing-side resolution
 *   isPlayoff      — playoff detection
 *   isBackToBack   — opposing team on second half of B2B
 */

// Per-stat form window: goals are higher variance, so widen the form window
// for goals/points to avoid one cold week dominating the signal.
const FORM_WINDOW_BY_STAT = {
  goals:         8,
  points:        5,
  assists:       5,
  shots_on_goal: 5,
};
const NHL_FORM_DEFAULT    = 5;
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

const stdDev = (values) => {
  if (!values?.length) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

/**
 * Linear recency-weighted mean. games[] is oldest → newest.
 * Newest game gets weight 2.0, oldest gets weight 1.0; everything in between
 * scales linearly. Single-game window degenerates to a simple mean.
 */
const recencyWeightedMean = (games, extract) => {
  if (!games?.length) return 0;
  const N = games.length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < N; i++) {
    const w = N === 1 ? 1 : 1 + (i / (N - 1)); // 1 .. 2
    const v = extract(games[i]);
    weightedSum += w * (Number.isFinite(v) ? v : 0);
    weightTotal += w;
  }
  return weightTotal > 0 ? parseFloat((weightedSum / weightTotal).toFixed(2)) : 0;
};

/** Extract focus stat value out of one game row, given statType. */
const _extractFocus = (statType) => {
  switch (statType) {
    case 'goals':         return (g) => n(g.goals);
    case 'assists':       return (g) => n(g.assists);
    case 'points':        return (g) => n(g.goals) + n(g.assists);
    case 'shots_on_goal': return (g) => n(g.shots);
    default:              return (g) => n(g.shots);
  }
};

// Forward TOI tiers (D-men typically run higher; tier label still useful as a cue)
const _classifyLineTier = (toiPerG, position) => {
  if (!Number.isFinite(toiPerG) || toiPerG <= 0) return 'unknown';
  if (position === 'D') {
    if (toiPerG >= 22) return 'top-pair';
    if (toiPerG >= 17) return 'second-pair';
    return 'third-pair';
  }
  // Forwards
  if (toiPerG >= 18) return 'top-6';
  if (toiPerG >= 13) return 'middle-6';
  return 'bottom-6';
};

// Position-aware TOI CV threshold — defensemen naturally swing more.
const _toiCVThreshold = (position) => (position === 'D' ? 0.35 : 0.30);

/**
 * applyNHLFormulas — compute window stats + NHL-specific metrics from raw log.
 *
 * Game-log rows are tagged by NHLStatsClient with:
 *   gameType (2|3), isPlayoff (bool), seasonId (string)
 *
 * The formulas are aware of these and surface season-mix metadata so the AI
 * can be told (and configured) to handle small playoff samples correctly.
 *
 * @param {Array}  rawStats    — game log from NHLAdapter (oldest → newest)
 * @param {string} statType    — 'shots_on_goal' | 'goals' | 'assists' | 'points'
 * @param {Object} [context]   — optional { position, isPlayoff, ... }
 * @returns {Object} processedStats consumed by buildNHLPrompt + StrategyService
 */
const applyNHLFormulas = (rawStats, statType = 'shots_on_goal', context = {}) => {
  if (!rawStats?.length) return {};

  // ── HARD SAMPLE-SIZE FLOOR ──────────────────────────────────────────────
  // Below 5 total games we still compute averages but force LOW confidence
  // so the AI cannot return "high" off a 3-game playoff slice.
  const tooThin = rawStats.length < 5;

  const formWindow = FORM_WINDOW_BY_STAT[statType] ?? NHL_FORM_DEFAULT;

  const formGames     = rawStats.slice(-formWindow);
  const edgeGames     = rawStats.slice(-NHL_EDGE_WINDOW);
  const baselineGames = rawStats.slice(-NHL_BASELINE_WINDOW);

  // Season-type composition of each window — used for trend scaling + prompt context.
  const countByType = (arr) => arr.reduce((acc, g) => {
    if (g.isPlayoff) acc.playoff++; else acc.regular++;
    return acc;
  }, { regular: 0, playoff: 0 });

  const formMix     = countByType(formGames);
  const edgeMix     = countByType(edgeGames);
  const baselineMix = countByType(baselineGames);

  const totalPlayoff = rawStats.reduce((n, g) => n + (g.isPlayoff ? 1 : 0), 0);
  const totalRegular = rawStats.length - totalPlayoff;
  const isMixedSeason = totalPlayoff > 0 && totalRegular > 0;

  const sumWindow = (games) => games.reduce((acc, g) => {
    acc.goals   += n(g.goals);
    acc.assists += n(g.assists);
    acc.points  += n(g.goals) + n(g.assists);
    acc.shots   += n(g.shots);              // NHLStatsClient already normalizes shotsOnGoal → shots
    acc.ppg     += n(g.powerPlayGoals);
    acc.pim     += n(g.penaltyMinutes) || n(g.pim);
    acc.pm      += n(g.plusMinus);
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

  // Edge averages (primary signal) — simple means surfaced for context
  const goalsPerG   = avg(eS.goals,   eC);
  const assistsPerG = avg(eS.assists, eC);
  const pointsPerG  = avg(eS.points,  eC);
  const shotsPerG   = avg(eS.shots,   eC);
  const toiPerG     = avg(eS.toi,     eC);
  const ppgPerG     = avg(eS.ppg,     eC);
  const pmPerG      = avg(eS.pm,      eC);

  // ── Even-strength vs PP goal split ────────────────────────────────────────
  const esGoalsPerG = parseFloat(Math.max(0, goalsPerG - ppgPerG).toFixed(2));
  const ppGoalsPerG = ppgPerG;

  // ── TOI variance (with position-aware threshold) ──────────────────────────
  // Position can come from context, or from the rawStats array's __playerInfo
  // (NHLAdapter pins resolved player info on the array as a non-enumerable prop).
  const position    = context?.position
                    || rawStats?.__playerInfo?.position
                    || null;
  const cvThreshold = _toiCVThreshold(position);
  const edgeTOIValues = edgeGames.map(g => parseTOI(g.timeOnIce || g.toi || '')).filter(t => t > 0);
  const meanTOI       = edgeTOIValues.length
    ? edgeTOIValues.reduce((s, v) => s + v, 0) / edgeTOIValues.length : 0;
  const toiStdDev     = stdDev(edgeTOIValues);
  const toiCV         = meanTOI > 0 ? toiStdDev / meanTOI : 0;
  const hasInconsistentTOI = toiCV > cvThreshold && edgeTOIValues.length >= 5;

  // ── Line / pairing tier from EDGE window TOI ──────────────────────────────
  const lineTier = _classifyLineTier(toiPerG, position);

  // ── PP dependence ─────────────────────────────────────────────────────────
  const ppDependencyPct = eS.goals > 0
    ? parseFloat(((eS.ppg / eS.goals) * 100).toFixed(0))
    : 0;
  const isPPDependent = ppDependencyPct > 40;

  // ── Shooting efficiency ──────────────────────────────────────────────────
  const shootingPct = eS.shots > 0
    ? parseFloat(((eS.goals / eS.shots) * 100).toFixed(1))
    : null;

  // ── Scoring streak / slump (using actual form window, can be 8g for goals) ─
  const formGoalRate = avg(fS.goals,  fC);
  const edgeGoalRate = avg(eS.goals,  eC);
  const onGoalStreak = formGoalRate >= edgeGoalRate * 1.5 && formGoalRate > 0;
  const onGoalSlump  = formGoalRate === 0 && edgeGoalRate > 0.2;

  // ── Recent stat values (for StrategyService confidence scoring) ──────────
  const recentStatValues = formGames.map(g => ({
    goals:         n(g.goals),
    assists:       n(g.assists),
    points:        n(g.goals) + n(g.assists),
    shots_on_goal: n(g.shots),
  }[statType] ?? 0));

  // ── Focus stat maps (simple means for BASELINE) ───────────────────────────
  const baseMap = {
    goals:         avg(bS.goals,   bC),
    assists:       avg(bS.assists, bC),
    points:        avg(bS.points,  bC),
    shots_on_goal: avg(bS.shots,   bC),
  };
  const baselineStatAvg = baseMap[statType] ?? avg(bS.shots, bC);

  // ── Recency-weighted FORM and EDGE means (newest game ~2x oldest) ─────────
  const focusFn          = _extractFocus(statType);
  const formStatAvg      = recencyWeightedMean(formGames, focusFn);
  const focusStatAvg     = recencyWeightedMean(edgeGames, focusFn);

  // Simple-mean variants kept for backward-compat consumers (StrategyService etc).
  const formStatAvgSimple = avg({
    goals:         fS.goals,
    assists:       fS.assists,
    points:        fS.points,
    shots_on_goal: fS.shots,
  }[statType] ?? fS.shots, fC);
  const focusStatAvgSimple = avg({
    goals:         eS.goals,
    assists:       eS.assists,
    points:        eS.points,
    shots_on_goal: eS.shots,
  }[statType] ?? eS.shots, eC);

  // ── Home / away splits inside the EDGE window ─────────────────────────────
  // homeRoadFlag is "H" for home, "R"/"A" for road (NHL game-log format).
  const isHomeRow = (g) => /^h/i.test(String(g?.homeRoadFlag ?? ''));
  const homeRows  = edgeGames.filter(isHomeRow);
  const awayRows  = edgeGames.filter(g => !isHomeRow(g) && g?.homeRoadFlag);
  const homeStatAvg = homeRows.length ? recencyWeightedMean(homeRows, focusFn) : null;
  const awayStatAvg = awayRows.length ? recencyWeightedMean(awayRows, focusFn) : null;
  const homeGames   = homeRows.length;
  const awayGames   = awayRows.length;

  // ── Head-to-head split (vs the team we're playing tonight) ────────────────
  // Looks across the FULL log, not just the EDGE window — playoffs face the
  // same opponent 4-7 times, and earlier-season meetings still inform expectation.
  const opp = (context?.opposingTeamAbbrev || '').toUpperCase();
  let h2hRows = [];
  if (opp) {
    h2hRows = rawStats.filter(g =>
      String(g?.opponentAbbrev || '').toUpperCase() === opp
    );
  }
  const h2hStatAvg = h2hRows.length ? recencyWeightedMean(h2hRows, focusFn) : null;
  const h2hCount   = h2hRows.length;

  // ── Data completeness ─────────────────────────────────────────────────────
  const hasFullFormWindow     = formGames.length     >= formWindow;
  const hasFullEdgeWindow     = edgeGames.length     >= NHL_EDGE_WINDOW;
  const hasFullBaselineWindow = baselineGames.length >= NHL_BASELINE_WINDOW;

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }
  if (tooThin) dataQuality = 'weak';

  // forceConfidence: hard cap on AI confidence regardless of edge signal.
  // Triggered when (a) sample is below the floor or (b) inconsistent TOI or
  // (c) edge window is mostly playoff with < 5 playoff games (high variance).
  let forceConfidence = null;
  const playoffOnlyEdgeWithThinSample =
    edgeMix.regular === 0 && edgeMix.playoff > 0 && edgeMix.playoff < 5;
  if (tooThin || hasInconsistentTOI || playoffOnlyEdgeWithThinSample) {
    forceConfidence = 'low';
  }

  return {
    // Window averages
    goalsPerG, assistsPerG, pointsPerG, shotsPerG, toiPerG, ppgPerG, pmPerG,
    esGoalsPerG, ppGoalsPerG,                  // ES vs PP goal split
    formStatAvg,                                // recency-weighted
    focusStatAvg:    parseFloat(focusStatAvg.toFixed(2)),  // recency-weighted
    formStatAvgSimple,                          // legacy/simple mean (for back-compat)
    focusStatAvgSimple,
    baselineStatAvg: parseFloat(baselineStatAvg.toFixed(2)),
    formWindowSize:  formWindow,
    formGamesCount:     fC,
    edgeGamesCount:     eC,
    baselineGamesCount: bC,
    hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow,
    recentStatValues,
    gamesAnalyzed: formGames.length,
    dataQuality,
    dataType: 'game_log',
    // Home / away split (EDGE window)
    homeStatAvg, awayStatAvg, homeGames, awayGames,
    // Head-to-head vs tonight's opponent (full log)
    h2hStatAvg, h2hCount,
    opposingTeamAbbrev: opp || null,

    // Season composition (NEW)
    formMix,                           // { regular, playoff } counts in form window
    edgeMix,                           // ditto for edge
    baselineMix,                       // ditto for baseline
    playoffGameCount: totalPlayoff,
    regularGameCount: totalRegular,
    isMixedSeason,
    tooThin,
    forceConfidence,                   // null | 'low' — buildNHLPrompt honors this

    // NHL-specific metrics
    hasInconsistentTOI,
    toiCV:            parseFloat(toiCV.toFixed(2)),
    toiCVThreshold:   cvThreshold,
    lineTier,
    ppDependencyPct,
    isPPDependent,
    shootingPct,
    onGoalStreak,
    onGoalSlump,
    formGoals:    fS.goals,
    edgeGoals:    eS.goals,
    position:     position || null,

    // For StrategyService
    focusStat: statType,
  };
};

// ─── AI Prompt Builder ────────────────────────────────────────────────────────

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
  isBackToBack   = false,
}) => {
  const label = {
    goals:         'Goals',
    assists:       'Assists',
    points:        'Points (G+A)',
    shots_on_goal: 'Shots on Goal',
  }[statType] || statType;

  const focusAvg = parseFloat(s.focusStatAvg) || 0;
  const signal   = focusAvg >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  // ── SEASON-TYPE SCALING FOR TREND ───────────────────────────────────────
  // Playoff scoring runs ~12% below regular season league-wide. When we're
  // in playoffs and the BASELINE window is mostly regular-season games, the
  // raw form-vs-baseline delta will look artificially negative. Scale the
  // baseline down before computing trend so the warning fires only on
  // *real* role/usage shifts, not the season-type discount.
  const PLAYOFF_SCORING_DISCOUNT = 0.88;
  const baselineMix = s.baselineMix || { regular: 0, playoff: 0 };
  const baselineRegularRatio = (baselineMix.regular + baselineMix.playoff) > 0
    ? baselineMix.regular / (baselineMix.regular + baselineMix.playoff) : 1;
  const shouldScaleBaseline = isPlayoff && baselineRegularRatio >= 0.5;

  const formAvg     = parseFloat(s.formStatAvg ?? 0);
  const baseAvgRaw  = parseFloat(s.baselineStatAvg ?? 0);
  const baseAvg     = shouldScaleBaseline ? baseAvgRaw * PLAYOFF_SCORING_DISCOUNT : baseAvgRaw;
  const trendPct    = (formAvg > 0 && baseAvg > 0)
    ? Math.round((formAvg - baseAvg) / baseAvg * 100) : null;
  const trendStr    = trendPct !== null && Math.abs(trendPct) >= 20
    ? ` ⚠️ TREND: ${trendPct > 0 ? '+' : ''}${trendPct}% vs baseline${shouldScaleBaseline ? ' (playoff-adjusted)' : ''}`
    : '';

  const toiWarning = s.hasInconsistentTOI
    ? `\n⚠️ INCONSISTENT TOI: CV=${s.toiCV} (>${s.toiCVThreshold}). Ice time is erratic — averages are less reliable. Lower confidence.`
    : '';

  const lineTierNote = s.lineTier && s.lineTier !== 'unknown'
    ? `\nLINE/PAIRING TIER: ${s.lineTier} (TOI ${s.toiPerG ?? 'n/a'}min/g)`
    : '';

  const ppNote = s.isPPDependent && s.ppDependencyPct > 0
    ? `\n⚡ PP DEPENDENT: ${s.ppDependencyPct}% of goals on power play. Prop exposed to PP opportunity variance.`
    : '';

  const streakNote = s.onGoalStreak
    ? `\n🔥 GOAL STREAK: ${s.formGoals} goals in last ${s.formGamesCount}g (above ${s.edgeGamesCount}g pace). Elevated form.`
    : s.onGoalSlump
    ? `\n❄️ GOAL SLUMP: 0 goals in last ${s.formGamesCount}g despite scoring ${s.edgeGoals} in last ${s.edgeGamesCount}g. Regression or slump.`
    : '';

  const shootNote = (statType === 'goals' || statType === 'points') && s.shootingPct != null
    ? `\n  Shooting%: ${s.shootingPct}% (goals/shots, last ${s.edgeGamesCount}g)`
    : '';

  const pmNote = Number.isFinite(s.pmPerG)
    ? ` | +/-: ${s.pmPerG > 0 ? '+' : ''}${s.pmPerG}`
    : '';

  // ── Goalie block ──────────────────────────────────────────────────────────
  let goalieBlock = '';
  if (goalieContext && playerSide) {
    const { buildGoaliePromptBlock } = require('./NHLGoalieService');
    goalieBlock = buildGoaliePromptBlock(playerSide, goalieContext, { isBackToBack });
  } else if (goalieContext && !playerSide) {
    const homeG = goalieContext.homeGoalie;
    const awayG = goalieContext.awayGoalie;
    if (homeG || awayG) {
      goalieBlock = [
        homeG ? `HOME GOALIE: ${homeG.name || '?'} SV%=${homeG.savePercentage ? (homeG.savePercentage*100).toFixed(1) : '?'} (${homeG.tier || '?'})` : '',
        awayG ? `AWAY GOALIE: ${awayG.name || '?'} SV%=${awayG.savePercentage ? (awayG.savePercentage*100).toFixed(1) : '?'} (${awayG.tier || '?'})` : '',
      ].filter(Boolean).join('\n');
    }
  }

  // ── Team block ────────────────────────────────────────────────────────────
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

  const playoffTag = isPlayoff
    ? '🏒 PLAYOFF GAME — defensive intensity higher, scoring rates 10-15% below regular season'
    : '';

  const b2bTag = isBackToBack
    ? '🛌 BACK-TO-BACK — opposing team on second half of B2B; backup goalie risk + tired legs'
    : '';

  // ── Season composition block ─────────────────────────────────────────────
  const formMix     = s.formMix     || { regular: 0, playoff: 0 };
  const edgeMix     = s.edgeMix     || { regular: 0, playoff: 0 };
  const baseMixOut  = s.baselineMix || { regular: 0, playoff: 0 };
  const seasonMixBlock = (s.isMixedSeason || isPlayoff)
    ? `SEASON MIX:
  FORM     window: ${formMix.regular} reg + ${formMix.playoff} playoff
  EDGE     window: ${edgeMix.regular} reg + ${edgeMix.playoff} playoff
  BASELINE window: ${baseMixOut.regular} reg + ${baseMixOut.playoff} playoff
  Total log: ${s.regularGameCount ?? 0} regular + ${s.playoffGameCount ?? 0} playoff${shouldScaleBaseline ? '  (baseline scaled −12% for playoff discount)' : ''}`
    : '';

  const sampleWarning = s.tooThin
    ? `\n⚠️ THIN SAMPLE: only ${(s.regularGameCount ?? 0) + (s.playoffGameCount ?? 0)} games in log — averages unreliable, force LOW confidence.`
    : '';

  const forceConfStr = s.forceConfidence
    ? `\n🔒 FORCE CONFIDENCE: "${s.forceConfidence}" — required regardless of edge signal due to ${s.tooThin ? 'thin sample' : s.hasInconsistentTOI ? 'inconsistent TOI' : 'small playoff sample'}.`
    : '';

  // ── Home/away split block ────────────────────────────────────────────────
  const sideTonightLabel = playerSide === 'home' ? 'AT HOME tonight'
                         : playerSide === 'away' ? 'ON ROAD tonight'
                         : null;
  const sideAvg = playerSide === 'home' ? s.homeStatAvg
                : playerSide === 'away' ? s.awayStatAvg
                : null;
  const sideAvgCount = playerSide === 'home' ? s.homeGames : (playerSide === 'away' ? s.awayGames : 0);
  const homeAwayBlock =
    (Number.isFinite(s.homeStatAvg) || Number.isFinite(s.awayStatAvg))
      ? `HOME/AWAY SPLIT (last ${s.edgeGamesCount}g):
  HOME: ${Number.isFinite(s.homeStatAvg) ? s.homeStatAvg : 'n/a'} (${s.homeGames}g)
  AWAY: ${Number.isFinite(s.awayStatAvg) ? s.awayStatAvg : 'n/a'} (${s.awayGames}g)${
    sideTonightLabel && Number.isFinite(sideAvg)
      ? `\n  → ${sideTonightLabel}: use ${sideAvg} (${sideAvgCount}g) as side-specific signal`
      : ''
  }`
      : '';

  // ── Head-to-head block (only when meaningful sample) ─────────────────────
  const h2hBlock = (s.h2hCount >= 2 && Number.isFinite(s.h2hStatAvg))
    ? `HEAD-TO-HEAD vs ${s.opposingTeamAbbrev}: ${label}=${s.h2hStatAvg} over ${s.h2hCount}g${
        Number.isFinite(s.focusStatAvg) && s.focusStatAvg > 0
          ? ` (vs season focus avg ${s.focusStatAvg} → ${
              s.h2hStatAvg > s.focusStatAvg * 1.15 ? '🟢 OVER lean'
              : s.h2hStatAvg < s.focusStatAvg * 0.85 ? '🔴 UNDER lean'
              : '⚪ neutral'
            })`
          : ''
      }`
    : '';

  // ── ES vs PP goal split (only relevant for goals/points) ─────────────────
  const esPpBlock = (statType === 'goals' || statType === 'points') &&
                    Number.isFinite(s.esGoalsPerG) && Number.isFinite(s.ppGoalsPerG)
    ? `STRENGTH-STATE GOAL SPLIT (last ${s.edgeGamesCount}g): ES=${s.esGoalsPerG}/g | PP=${s.ppGoalsPerG}/g`
    : '';

  return `You are an expert NHL prop betting analyst. Respond with ONLY a JSON object.

PLAYER: ${playerName} | STAT: ${label} | LINE: ${bettingLine}
SIGNAL: ${signal} (${s.edgeGamesCount ?? NHL_EDGE_WINDOW}-game avg ${focusAvg} vs line ${bettingLine})
${playoffTag}
${b2bTag}

${goalieBlock ? `GOALIE MATCHUP:\n${goalieBlock}\n` : ''}${teamBlock ? `\nTEAM CONTEXT:\n${teamBlock}\n` : ''}
THREE-WINDOW ANALYSIS:
  FORM     (last ${s.formGamesCount ?? s.formWindowSize ?? NHL_FORM_DEFAULT}g, ${s.hasFullFormWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${formAvg.toFixed(2)}${trendStr}
  EDGE     (last ${s.edgeGamesCount ?? NHL_EDGE_WINDOW}g, ${s.hasFullEdgeWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${focusAvg} | Goals/g=${s.goalsPerG ?? 'N/A'} | Assists/g=${s.assistsPerG ?? 'N/A'} | SOG/g=${s.shotsPerG ?? 'N/A'} | TOI/g=${s.toiPerG ?? 'N/A'}min${pmNote}  ← PRIMARY${shootNote}
  BASELINE (last ${s.baselineGamesCount ?? NHL_BASELINE_WINDOW}g, ${s.hasFullBaselineWindow ? 'COMPLETE' : 'PARTIAL'}): ${label}=${baseAvg.toFixed(2)}${shouldScaleBaseline ? `  (raw=${baseAvgRaw.toFixed(2)})` : ''}
  RECENT ${label.toUpperCase()} (last ${s.formGamesCount ?? s.formWindowSize ?? NHL_FORM_DEFAULT}g): ${recent}
  DATA WINDOWS: ${completeness}
${seasonMixBlock ? `\n${seasonMixBlock}\n` : ''}${homeAwayBlock ? `\n${homeAwayBlock}\n` : ''}${h2hBlock ? `\n${h2hBlock}\n` : ''}${esPpBlock ? `\n${esPpBlock}\n` : ''}${lineTierNote}${toiWarning}${ppNote}${streakNote}${sampleWarning}${forceConfStr}
${injuryContext ? `\nINJURY/STATUS: ${injuryContext}` : ''}

ANALYST RULES:
  - PRIMARY signal = ${s.edgeGamesCount ?? NHL_EDGE_WINDOW}-game avg vs line
  - GOALIE MATCHUP is a strong modifier — elite goalie (SV% > .930) suppresses shots AND goals
  - Recent goalie form (HOT/COLD tag) overrides season tier when it diverges meaningfully
  - OPPOSING DEFENSE — GA/G and SA/G already labeled; use them as direct modifiers
  - PP%/PK% mismatch (e.g., elite PP vs weak PK) elevates expected scoring for PP-heavy players
  - 🛌 BACK-TO-BACK on opponent → backup likely; lean OVER on shots/goals if backup is weak
  - ⚠️ INCONSISTENT TOI → force "low" confidence regardless of edge signal
  - ⚡ PP DEPENDENT → factor in PP opportunity uncertainty
  - 🏒 PLAYOFF games: scoring 10-15% lower than regular season — already adjusted in BASELINE if scaled
  - SEASON MIX: weight playoff games higher in FORM (recency), but trust the BASELINE for true talent rate
  - SHOTS on goal is most consistent; GOALS are high variance (even elite scorers go cold)
  - HOME/AWAY split: when the side-specific avg differs >15% from the EDGE avg, weight the side-specific avg
  - HEAD-TO-HEAD vs tonight's opponent: when sample ≥3, the h2h avg is a stronger signal than season avg
  - ES vs PP split: PP-heavy goal scorer (PP > ES) is exposed to tonight's PP-opportunity variance — see PP%/PK% above
  - FORM/EDGE means are RECENCY-WEIGHTED (newest game ~2x oldest). Treat the form number as already biased toward last few games
  - If ⚠️ TREND: form shifted >20% from baseline → weight FORM window over EDGE
  - PARTIAL windows → lean "moderate" or "low" confidence
  - 🔒 FORCE CONFIDENCE label is mandatory — do not exceed it regardless of signal strength
  - ⚠️ THIN SAMPLE → must return "low" confidence and "weak" dataQuality
  - INJURY status of "Out"/"Doubtful" → recommend UNDER with HIGH confidence (player likely won't play full game)

Return exactly:
{"recommendation":"over"|"under","confidence":"low"|"medium"|"high","summary":"≤25 words citing key number","factors":["goalie/team matchup","form+edge signal","TOI or PP context"],"risks":["primary risk that could flip the pick"],"dataQuality":"strong"|"moderate"|"weak"}`;
};

module.exports = { applyNHLFormulas, buildNHLPrompt, parseTOI };

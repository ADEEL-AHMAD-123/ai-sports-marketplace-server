/**
 * MLBFormulas.js — MLB stat processing
 *
 * DATA SOURCE: Official MLB Stats API (statsapi.mlb.com)
 * Free, no key, official MLB data used by ESPN/FanGraphs.
 *
 * HITTING game log stat fields (from /people/{id}/stats?group=hitting):
 *   hits, homeRuns, rbi, runs, atBats, totalBases,
 *   baseOnBalls, strikeOuts, avg, obp, slg, ops
 *
 * PITCHING game log stat fields (from /people/{id}/stats?group=pitching):
 *   strikeOuts, inningsPitched ("6.1" = 6⅓ innings),
 *   earnedRuns, hits, baseOnBalls, era, whip
 *
 * NOTE on inningsPitched: "6.1" = 6 + 1/3 (NOT 6.1 decimal)
 *
 * WINDOWS:
 *  Batters:  FORM=last 10g, EDGE=last 15g, BASELINE=last 30g
 *  Pitchers: FORM=last 3 starts, EDGE=last 5 starts, BASELINE=last 10 starts
 *
 * SESSION 2 IMPROVEMENT:
 *  buildMLBPrompt now accepts starterContext param.
 *  Adds MATCHUP section showing opposing starter's ERA/WHIP/K9 for batter props.
 */

const logger = require('../../../config/logger');
const { buildParkContextBlock } = require('./MLBBallparkFactors');
const { buildPlatoonBlock } = require('./MLBPlatoonService');

const MLB_BATTER_FORM_WINDOW  = 10;
const MLB_BATTER_EDGE_WINDOW  = 15;
const MLB_BATTER_BASE_WINDOW  = 30;
const MLB_PITCHER_FORM_WINDOW = 3;
const MLB_PITCHER_EDGE_WINDOW = 5;
const MLB_PITCHER_BASE_WINDOW = 10;

/**
 * Parse innings pitched string.
 * "6.1" = 6 + 1/3 = 6.333 (NOT 6.1 decimal)
 */
const parseIP = (ipStr) => {
  if (!ipStr && ipStr !== 0) return 0;
  const s = String(ipStr);
  const [whole, frac = '0'] = s.split('.');
  return parseInt(whole, 10) + parseInt(frac, 10) / 3;
};

const n   = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const avg = (val, count) => count > 0 ? parseFloat((val / count).toFixed(2)) : 0;

// ─── Batter formulas ──────────────────────────────────────────────────────────

const applyMLBBatterFormulas = (rawStats, statType = 'hits') => {
  if (!rawStats?.length) return {};

  const formGames = rawStats.slice(-MLB_BATTER_FORM_WINDOW);
  const edgeGames = rawStats.slice(-MLB_BATTER_EDGE_WINDOW);
  const baseGames = rawStats.slice(-MLB_BATTER_BASE_WINDOW);

  const sumB = (games) => games.reduce((acc, g) => {
    acc.hits += n(g.hits);
    acc.hr   += n(g.homeRuns);
    acc.rbi  += n(g.rbi);
    acc.runs += n(g.runs);
    acc.tb   += n(g.totalBases);
    acc.ab   += n(g.atBats);
    acc.bb   += n(g.baseOnBalls);
    acc.k    += n(g.strikeOuts);
    acc.games++;
    return acc;
  }, { hits:0, hr:0, rbi:0, runs:0, tb:0, ab:0, bb:0, k:0, games:0 });

  const fT = sumB(formGames);
  const eT = sumB(edgeGames);
  const bT = sumB(baseGames);
  const fC = fT.games || 1;
  const eC = eT.games || 1;
  const bC = bT.games || 1;

  const hasFullFormWindow     = formGames.length >= MLB_BATTER_FORM_WINDOW;
  const hasFullEdgeWindow     = edgeGames.length >= MLB_BATTER_EDGE_WINDOW;
  const hasFullBaselineWindow = baseGames.length >= MLB_BATTER_BASE_WINDOW;

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }

  const hitsPerG = avg(eT.hits, eC);
  const tbPerG   = avg(eT.tb,   eC);
  const runsPerG = avg(eT.runs, eC);
  const hrPerG   = avg(eT.hr,   eC);
  const rbiPerG  = avg(eT.rbi,  eC);

  const lastGame   = rawStats[rawStats.length - 1] || {};
  const battingAvg = parseFloat(lastGame.avg) || avg(eT.hits, eT.ab || 1);
  const obp        = parseFloat(lastGame.obp) || 0;
  const slg        = parseFloat(lastGame.slg) || 0;
  const ops        = parseFloat(lastGame.ops) || parseFloat((obp + slg).toFixed(3));

  const formHitsPerG = avg(fT.hits, fC);
  const formTBPerG   = avg(fT.tb,   fC);

  const focusMap = {
    hits: hitsPerG, total_bases: tbPerG, runs: runsPerG,
    home_runs: hrPerG, rbis: rbiPerG,
  };
  const baseMap = {
    hits: avg(bT.hits, bC), total_bases: avg(bT.tb, bC),
    runs: avg(bT.runs, bC), home_runs: avg(bT.hr, bC), rbis: avg(bT.rbi, bC),
  };
  const formMap = {
    hits: formHitsPerG, total_bases: formTBPerG,
    runs: avg(fT.runs, fC), home_runs: avg(fT.hr, fC), rbis: avg(fT.rbi, fC),
  };

  const recentStatValues = formGames.map(g => ({
    hits:        n(g.hits),
    total_bases: n(g.totalBases),
    runs:        n(g.runs),
    home_runs:   n(g.homeRuns),
    rbis:        n(g.rbi),
  }[statType] ?? 0));

  return {
    hitsPerG, tbPerG, runsPerG, hrPerG, rbiPerG,
    battingAvg, obp, slg, ops,
    formHitsPerG, formTBPerG,
    formStatAvg:  formMap[statType] ?? focusMap[statType],
    edgeGamesCount:    eC,
    formGamesCount:    fC,
    baselineGamesCount: bC,
    hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow,
    recentStatValues,
    gamesAnalyzed: formGames.length,
    focusStat:      statType,
    focusStatAvg:   parseFloat((focusMap[statType] ?? hitsPerG).toFixed(2)),
    baselineStatAvg: parseFloat((baseMap[statType] ?? hitsPerG).toFixed(2)),
    dataQuality,
    dataType: 'game_log',
  };
};

// ─── Pitcher formulas ─────────────────────────────────────────────────────────

const applyMLBPitcherFormulas = (rawStats, statType = 'pitcher_strikeouts') => {
  if (!rawStats?.length) return {};

  const starts = rawStats.filter(g => parseIP(g.inningsPitched) > 0);
  if (!starts.length) return {};

  const formS = starts.slice(-MLB_PITCHER_FORM_WINDOW);
  const edgeS = starts.slice(-MLB_PITCHER_EDGE_WINDOW);
  const baseS = starts.slice(-MLB_PITCHER_BASE_WINDOW);

  const sumP = (games) => games.reduce((acc, g) => {
    acc.k  += n(g.strikeOuts);
    acc.ip += parseIP(g.inningsPitched);
    acc.er += n(g.earnedRuns);
    acc.h  += n(g.hits);
    acc.bb += n(g.baseOnBalls);
    acc.games++;
    return acc;
  }, { k:0, ip:0, er:0, h:0, bb:0, games:0 });

  const fS = sumP(formS);
  const eS = sumP(edgeS);
  const bS = sumP(baseS);
  const fC = fS.games || 1;
  const eC = eS.games || 1;

  const hasFullFormWindow     = formS.length >= MLB_PITCHER_FORM_WINDOW;
  const hasFullEdgeWindow     = edgeS.length >= MLB_PITCHER_EDGE_WINDOW;
  const hasFullBaselineWindow = baseS.length >= MLB_PITCHER_BASE_WINDOW;

  let dataQuality = 'strong';
  if (!hasFullFormWindow || !hasFullEdgeWindow || !hasFullBaselineWindow) {
    dataQuality = hasFullEdgeWindow ? 'moderate' : 'weak';
  }

  const kPerStart  = avg(eS.k,  eC);
  const ipPerStart = avg(eS.ip, eC);
  const era        = eS.ip > 0 ? parseFloat(((eS.er / eS.ip) * 9).toFixed(2)) : null;
  const whip       = eS.ip > 0 ? parseFloat(((eS.bb + eS.h) / eS.ip).toFixed(2)) : null;
  const k9         = eS.ip > 0 ? parseFloat(((eS.k  / eS.ip) * 9).toFixed(1)) : null;
  const formK      = avg(fS.k,  fC);

  const recentKValues = formS.map(g => n(g.strikeOuts));

  return {
    kPerStart, ipPerStart, era, whip, k9, formKPerStart: formK,
    edgeGamesCount:    eC,
    formGamesCount:    fC,
    baselineGamesCount: bS.games || 1,
    hasFullFormWindow, hasFullEdgeWindow, hasFullBaselineWindow,
    recentStatValues:  recentKValues,
    gamesAnalyzed:     formS.length,
    focusStat:         statType,
    focusStatAvg:      parseFloat(kPerStart.toFixed(2)),
    baselineStatAvg:   parseFloat(avg(bS.k, bS.games || 1).toFixed(2)),
    dataQuality,
    dataType: 'game_log',
  };
};

const applyMLBFormulas = (rawStats, statType = 'hits', context = {}) => {
  const isPitcher = statType === 'pitcher_strikeouts' || context.isPitcher === true;
  return isPitcher
    ? applyMLBPitcherFormulas(rawStats, statType)
    : applyMLBBatterFormulas(rawStats, statType);
};

// ─── AI Prompt ────────────────────────────────────────────────────────────────

/**
 * Build MLB AI prompt with optional starter matchup context (Session 2).
 *
 * @param {Object} params
 * @param {Object} params.processedStats
 * @param {string} params.playerName
 * @param {string} params.statType
 * @param {number} params.bettingLine
 * @param {boolean} params.isPitcher
 * @param {string} params.injuryContext
 * @param {Object|null} params.starterContext  — SESSION 2: opposing starter info
 *   { starterName, starterStats } or null
 */
const buildMLBPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  isPitcher = false,
  injuryContext  = '',
  starterContext  = null,   // { starterName, starterStats } — Session 2
  parkContext     = null,   // { homeTeamName } — Session 4
  platoonContext  = null,   // { matchup } — Session 5
}) => {
  const label = {
    hits: 'Hits', total_bases: 'Total Bases', pitcher_strikeouts: 'Strikeouts',
    runs: 'Runs', rbis: 'RBIs', home_runs: 'Home Runs',
  }[statType] || statType;

  const focusAvg    = parseFloat(s.focusStatAvg) || 0;
  const baselineAvg = parseFloat(s.baselineStatAvg) || 0;
  const signal      = focusAvg >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  // Trend detection
  const formAvg  = parseFloat(s.formStatAvg ?? s.formKPerStart ?? 0);
  const trendPct = (formAvg > 0 && baselineAvg > 0)
    ? Math.round((formAvg - baselineAvg) / baselineAvg * 100) : null;
  const trendStr = trendPct !== null && Math.abs(trendPct) >= 20
    ? ` ⚠️ TREND: ${trendPct > 0 ? '+' : ''}${trendPct}% vs baseline` : '';

  const edgeCount  = s.edgeGamesCount     || 0;
  const formCount  = s.formGamesCount     || s.gamesAnalyzed || 0;
  const baseCount  = s.baselineGamesCount || 0;

  const formLabel     = `FORM (last ${formCount}${isPitcher ? ' starts' : 'g'})${s.hasFullFormWindow ? '' : ' [PARTIAL]'}`;
  const edgeLabel     = `EDGE (last ${edgeCount}${isPitcher ? ' starts' : 'g'})${s.hasFullEdgeWindow ? '' : ' [PARTIAL]'}`;
  const baselineLabel = `BASELINE (last ${baseCount}g)${s.hasFullBaselineWindow ? '' : ' [PARTIAL]'}`;

  let statsBlock;
  if (isPitcher) {
    const recent = (s.recentStatValues || []).join(', ') || 'N/A';
    statsBlock = [
      `${formLabel}: K/start=${s.formKPerStart ?? 'N/A'}${trendStr}`,
      `${edgeLabel}: K/start=${focusAvg} | ERA=${s.era ?? 'N/A'} | WHIP=${s.whip ?? 'N/A'} | K/9=${s.k9 ?? 'N/A'} | IP/start=${s.ipPerStart ?? 'N/A'}  ← PRIMARY`,
      `${baselineLabel}: K/start=${baselineAvg}`,
      `RECENT K (last ${formCount} starts): ${recent}`,
    ].join('\n');
  } else {
    const focusFormAvg = s.formStatAvg ?? 'N/A';
    const recent = (s.recentStatValues || []).join(', ') || 'N/A';
    statsBlock = [
      `${formLabel}: ${label}/g=${focusFormAvg}${trendStr}`,
      `${edgeLabel}: ${label}/g=${focusAvg} | Hits/g=${s.hitsPerG ?? 'N/A'} | TB/g=${s.tbPerG ?? 'N/A'} | AVG=${s.battingAvg ?? 'N/A'} | OBP=${s.obp ?? 'N/A'} | SLG=${s.slg ?? 'N/A'}  ← PRIMARY`,
      `${baselineLabel}: ${label}/g=${baselineAvg}`,
      `RECENT ${label.toUpperCase()} (last ${formCount}g): ${recent}`,
    ].join('\n');
  }

  // Session 2: Starter matchup block for batter props
  const { buildStarterMatchupBlock } = require('./MLBStarterService');
  const matchupBlock = (!isPitcher && starterContext)
    ? buildStarterMatchupBlock(starterContext.starterName, starterContext.starterStats)
    : '';

  // Session 4: Ballpark factor block for batter props
  const parkBlock = (!isPitcher && parkContext?.homeTeamName)
    ? buildParkContextBlock(parkContext.homeTeamName, statType)
    : '';

  // Session 5: Platoon split block for batter props
  const platoonBlock = (!isPitcher && platoonContext?.matchup)
    ? buildPlatoonBlock(platoonContext.matchup)
    : '';

  return `You are an expert MLB prop betting analyst. Respond with ONLY a JSON object.

PLAYER: ${playerName} (${isPitcher ? 'PITCHER' : 'BATTER'}) | STAT: ${label} | LINE: ${bettingLine}
SIGNAL: ${signal} (${edgeCount}-game avg ${focusAvg} vs line ${bettingLine})

${statsBlock}
${matchupBlock ? `\n${matchupBlock}\n` : ''}${platoonBlock ? `\n${platoonBlock}\n` : ''}${parkBlock ? `\n${parkBlock}\n` : ''}${injuryContext ? `\nSTATUS: ${injuryContext}` : ''}

ANALYST RULES:
  - PRIMARY signal = edge window avg (${edgeCount}g) vs line
  - If ⚠️ TREND: recent form has shifted — weight form heavily, role/streak has changed
  - MATCHUP: high K/9 starter (>10.0) → lean UNDER on hits/TB; high WHIP (>1.35) → lean OVER on runs/RBIs
  - PLATOON: 🟢 FAVORABLE matchup (cross-hand) = lean OVER hits/TB/OBP; 🔴 UNFAVORABLE = lean UNDER
  - BALLPARK: 🔴 HITTER-FRIENDLY boosts OVER confidence; 🟢 PITCHER-FRIENDLY boosts UNDER confidence
  - Coors Field (factor 1.28) is the strongest park effect — always cite in factors if present
  - Pitcher K's: most predictable stat, park factor has minimal effect on Ks
  - Partial windows [PARTIAL] → increase uncertainty, lean toward "moderate" confidence

Return exactly:
{"recommendation":"over"|"under","confidence":"low"|"medium"|"high","summary":"≤25 words citing key number","factors":["specific stat + window","second data point","matchup context if available"],"risks":["primary risk"],"dataQuality":"strong"|"moderate"|"weak"}`;
};

module.exports = { applyMLBFormulas, applyMLBBatterFormulas, applyMLBPitcherFormulas, buildMLBPrompt, parseIP };
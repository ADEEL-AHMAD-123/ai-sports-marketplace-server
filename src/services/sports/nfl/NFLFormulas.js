/**
 * NFLFormulas.js — NFL stat processing + prompt builder
 *
 * Supports common NFL player props:
 *   - passing_yards
 *   - rushing_yards
 *   - receiving_yards
 *   - receptions
 *   - pass_tds
 *   - rush_reception_yards
 */

const FORM_WINDOW = 5;
const EDGE_WINDOW = 8;
const BASELINE_WINDOW = 17;

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const avg = (sum, count) => (count > 0 ? parseFloat((sum / count).toFixed(2)) : 0);

const pick = (obj, paths = []) => {
  for (const path of paths) {
    const val = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    if (val !== undefined && val !== null && val !== '') return n(val);
  }
  return 0;
};

const valueByType = (row, statType) => {
  const passingYards = pick(row, ['passing.yards', 'passing.yardsNet', 'passingYards', 'passYards']);
  const rushingYards = pick(row, ['rushing.yards', 'rushingYards', 'rushYards']);
  const receivingYards = pick(row, ['receiving.yards', 'receivingYards', 'recYards']);
  const receptions = pick(row, ['receiving.receptions', 'receiving.recp', 'receptions']);
  const passTDs = pick(row, ['passing.touchdowns', 'passing.passingTouchdowns', 'passTD', 'passTds']);

  if (statType === 'passing_yards') return passingYards;
  if (statType === 'rushing_yards') return rushingYards;
  if (statType === 'receiving_yards') return receivingYards;
  if (statType === 'receptions') return receptions;
  if (statType === 'pass_tds') return passTDs;
  if (statType === 'rush_reception_yards') return rushingYards + receivingYards;
  return passingYards;
};

const applyNFLFormulas = (rawStats, statType = 'passing_yards') => {
  if (!rawStats?.length) return {};

  const form = rawStats.slice(-FORM_WINDOW);
  const edge = rawStats.slice(-EDGE_WINDOW);
  const base = rawStats.slice(-BASELINE_WINDOW);

  const sumWindow = (rows) => rows.reduce((acc, r) => {
    acc.values += valueByType(r, statType);
    acc.games += 1;
    return acc;
  }, { values: 0, games: 0 });

  const f = sumWindow(form);
  const e = sumWindow(edge);
  const b = sumWindow(base);

  const fCount = f.games || 1;
  const eCount = e.games || 1;
  const bCount = b.games || 1;

  const recentStatValues = form.map((r) => valueByType(r, statType));

  let dataQuality = 'strong';
  if (rawStats.length < EDGE_WINDOW) dataQuality = 'moderate';
  if (rawStats.length < FORM_WINDOW) dataQuality = 'weak';

  return {
    focusStat: statType,
    focusStatAvg: avg(e.values, eCount),
    formStatAvg: avg(f.values, fCount),
    baselineStatAvg: avg(b.values, bCount),
    recentStatValues,
    gamesAnalyzed: form.length,
    edgeGamesCount: eCount,
    formGamesCount: fCount,
    baselineGamesCount: bCount,
    hasFullFormWindow: form.length >= FORM_WINDOW,
    hasFullEdgeWindow: edge.length >= EDGE_WINDOW,
    hasFullBaselineWindow: base.length >= BASELINE_WINDOW,
    dataQuality,
    dataType: 'game_log',
  };
};

const buildNFLPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  injuryContext = '',
  gameContext = null,
  teamContext = null,
}) => {
  const label = {
    passing_yards: 'Passing Yards',
    rushing_yards: 'Rushing Yards',
    receiving_yards: 'Receiving Yards',
    receptions: 'Receptions',
    pass_tds: 'Passing TDs',
    rush_reception_yards: 'Rush+Rec Yards',
  }[statType] || statType;

  const focus = parseFloat(s.focusStatAvg) || 0;
  const baseline = parseFloat(s.baselineStatAvg) || 0;
  const signal = focus >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  const gameCtxBlock = gameContext
    ? [
        'GAME CONTEXT',
        `- Kickoff (UTC): ${gameContext.kickoffIso || 'n/a'}`,
        `- Weekend: ${gameContext.isWeekend ? 'yes' : 'no'}`,
        `- Prime window (UTC): ${gameContext.isPrimeWindowUtc ? 'yes' : 'no'}`,
      ].join('\n')
    : null;

  const teamCtxBlock = teamContext
    ? [
        'MATCHUP CONTEXT',
        `- ${teamContext.homeTeamName || 'Home'} recent: ${teamContext.homeForm?.pointsForPerGame ?? 'n/a'} PF/G, ${teamContext.homeForm?.pointsAgainstPerGame ?? 'n/a'} PA/G (${teamContext.homeForm?.games ?? 0}g)`,
        `- ${teamContext.awayTeamName || 'Away'} recent: ${teamContext.awayForm?.pointsForPerGame ?? 'n/a'} PF/G, ${teamContext.awayForm?.pointsAgainstPerGame ?? 'n/a'} PA/G (${teamContext.awayForm?.games ?? 0}g)`,
        `- Rest days: home ${teamContext.homeRestDays ?? 'n/a'} | away ${teamContext.awayRestDays ?? 'n/a'} | edge ${teamContext.restEdgeDays ?? 'n/a'}`,
        `- Short rest flag: ${teamContext.hasShortRest ? 'yes' : 'no'}`,
      ].join('\n')
    : null;

  return [
    'Analyze this NFL player prop and decide OVER or UNDER.',
    `Player: ${playerName}`,
    `Stat: ${label}`,
    `Line: ${bettingLine}`,
    `Signal from recent form: ${signal}`,
    '',
    'WINDOWS',
    `- Form avg: ${s.formStatAvg ?? 'n/a'} (${s.formGamesCount ?? 0} games)`,
    `- Edge avg: ${focus} (${s.edgeGamesCount ?? 0} games)`,
    `- Baseline avg: ${baseline} (${s.baselineGamesCount ?? 0} games)`,
    '',
    `- Recent values: ${(s.recentStatValues || []).join(', ') || 'n/a'}`,
    gameCtxBlock,
    teamCtxBlock,
    injuryContext ? `INJURY CONTEXT\n${injuryContext}\n` : '',
    'Return:',
    '1) OVER or UNDER',
    '2) Short evidence-based rationale',
    '3) Confidence 0-100',
  ].filter(Boolean).join('\n');
};

module.exports = {
  applyNFLFormulas,
  buildNFLPrompt,
};

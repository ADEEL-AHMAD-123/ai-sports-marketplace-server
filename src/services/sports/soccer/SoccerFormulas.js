/**
 * SoccerFormulas.js — Soccer stat processing + prompt builder
 *
 * Supports EPL player props:
 *  - goals
 *  - assists
 *  - shots_on_target
 */

const FORM_WINDOW = 5;
const EDGE_WINDOW = 8;
const BASE_WINDOW = 20;

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const avg = (sum, count) => (count > 0 ? parseFloat((sum / count).toFixed(2)) : 0);

const valueByType = (row, statType) => {
  if (statType === 'goals') return n(row.goals);
  if (statType === 'assists') return n(row.assists);
  if (statType === 'shots_on_target') return n(row.shots_on_target);
  return n(row.shots_on_target);
};

const applySoccerFormulas = (rawStats, statType = 'shots_on_target') => {
  if (!rawStats?.length) return {};

  const form = rawStats.slice(-FORM_WINDOW);
  const edge = rawStats.slice(-EDGE_WINDOW);
  const base = rawStats.slice(-BASE_WINDOW);

  const sumWindow = (rows) => rows.reduce((acc, r) => {
    acc.goals += n(r.goals);
    acc.assists += n(r.assists);
    acc.sot += n(r.shots_on_target);
    acc.minutes += n(r.minutes || 0);
    acc.games += 1;
    return acc;
  }, { goals: 0, assists: 0, sot: 0, minutes: 0, games: 0 });

  const f = sumWindow(form);
  const e = sumWindow(edge);
  const b = sumWindow(base);

  const fCount = f.games || 1;
  const eCount = e.games || 1;
  const bCount = b.games || 1;

  const goalsPerG = avg(e.goals, eCount);
  const assistsPerG = avg(e.assists, eCount);
  const sotPerG = avg(e.sot, eCount);
  const minutesPerG = avg(e.minutes, eCount);

  const focusMap = {
    goals: goalsPerG,
    assists: assistsPerG,
    shots_on_target: sotPerG,
  };

  const baselineMap = {
    goals: avg(b.goals, bCount),
    assists: avg(b.assists, bCount),
    shots_on_target: avg(b.sot, bCount),
  };

  const formMap = {
    goals: avg(f.goals, fCount),
    assists: avg(f.assists, fCount),
    shots_on_target: avg(f.sot, fCount),
  };

  const recentStatValues = form.map((r) => valueByType(r, statType));

  const conversionPct = e.sot > 0
    ? parseFloat(((e.goals / e.sot) * 100).toFixed(1))
    : null;

  let dataQuality = 'strong';
  if (rawStats.length < EDGE_WINDOW) dataQuality = 'moderate';
  if (rawStats.length < FORM_WINDOW) dataQuality = 'weak';

  return {
    goalsPerG,
    assistsPerG,
    shotsOnTargetPerG: sotPerG,
    minutesPerG,
    conversionPct,
    recentStatValues,
    gamesAnalyzed: form.length,
    focusStat: statType,
    focusStatAvg: focusMap[statType] ?? sotPerG,
    formStatAvg: formMap[statType] ?? sotPerG,
    baselineStatAvg: baselineMap[statType] ?? sotPerG,
    edgeGamesCount: eCount,
    formGamesCount: fCount,
    baselineGamesCount: bCount,
    hasFullFormWindow: form.length >= FORM_WINDOW,
    hasFullEdgeWindow: edge.length >= EDGE_WINDOW,
    hasFullBaselineWindow: base.length >= BASE_WINDOW,
    dataQuality,
    dataType: 'game_log',
  };
};

const buildSoccerPrompt = ({
  processedStats: s = {},
  playerName,
  statType,
  bettingLine,
  injuryContext = '',
}) => {
  const label = {
    goals: 'Goals',
    assists: 'Assists',
    shots_on_target: 'Shots on Target',
  }[statType] || statType;

  const focus = parseFloat(s.focusStatAvg) || 0;
  const baseline = parseFloat(s.baselineStatAvg) || 0;
  const signal = focus >= parseFloat(bettingLine) ? 'OVER' : 'UNDER';

  return [
    `Analyze this EPL player prop and decide OVER or UNDER.`,
    `Player: ${playerName}`,
    `Stat: ${label}`,
    `Line: ${bettingLine}`,
    `Signal from recent form: ${signal}`,
    '',
    `WINDOWS`,
    `- Form avg: ${s.formStatAvg ?? 'n/a'} (${s.formGamesCount ?? 0} matches)`,
    `- Edge avg: ${focus} (${s.edgeGamesCount ?? 0} matches)`,
    `- Baseline avg: ${baseline} (${s.baselineGamesCount ?? 0} matches)`,
    '',
    `SUPPORTING METRICS`,
    `- Goals/match: ${s.goalsPerG ?? 'n/a'}`,
    `- Assists/match: ${s.assistsPerG ?? 'n/a'}`,
    `- Shots on target/match: ${s.shotsOnTargetPerG ?? 'n/a'}`,
    `- Minutes/match: ${s.minutesPerG ?? 'n/a'}`,
    `- Conversion%: ${s.conversionPct ?? 'n/a'}`,
    '',
    injuryContext ? `INJURY CONTEXT\n${injuryContext}\n` : '',
    'Return:',
    '1) OVER or UNDER',
    '2) Short evidence-based rationale',
    '3) Confidence 0-100',
  ].filter(Boolean).join('\n');
};

module.exports = {
  applySoccerFormulas,
  buildSoccerPrompt,
};

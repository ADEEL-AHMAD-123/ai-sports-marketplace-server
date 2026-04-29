require('dotenv').config();

const fs = require('fs');
const path = require('path');
const connectDB = require('../src/config/database');
const mongoose = require('mongoose');
const Insight = require('../src/models/Insight.model');
const { Game } = require('../src/models/Game.model');

function escCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function mdCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

(async () => {
  await connectDB();

  const statusArg = process.argv.find((arg) => arg.startsWith('--status='));
  const statusFilter = statusArg ? statusArg.split('=')[1] : 'all';
  const insightQuery = statusFilter && statusFilter !== 'all'
    ? { status: statusFilter }
    : {};

  const insights = await Insight.find(insightQuery)
    .sort({ createdAt: -1 })
    .select([
      '_id',
      'createdAt',
      'sport',
      'eventId',
      'playerName',
      'statType',
      'bettingLine',
      'recommendation',
      'focusStatAvg',
      'confidenceScore',
      'edgePercentage',
      'isHighConfidence',
      'isBestValue',
      'status',
      'oddsSnapshot.line',
      'aiLog.processedStats.focusStatAvg',
    ].join(' '))
    .lean();

  const eventIds = [...new Set(insights.map((i) => i.eventId).filter(Boolean))];
  const games = await Game.find({ oddsEventId: { $in: eventIds } })
    .select('oddsEventId status startTime homeTeam.name awayTeam.name')
    .lean();
  const gameByEvent = new Map(games.map((g) => [g.oddsEventId, g]));

  const rows = insights.map((i) => {
    const g = gameByEvent.get(i.eventId);
    const predicted = i.focusStatAvg ?? i.aiLog?.processedStats?.focusStatAvg ?? null;

    return {
      insightId: i._id?.toString() || '',
      createdAt: i.createdAt ? new Date(i.createdAt).toISOString() : '',
      sport: i.sport || '',
      gameStatus: g?.status || '',
      eventId: i.eventId || '',
      game: g ? `${g.awayTeam?.name || '?'} vs ${g.homeTeam?.name || '?'}` : '',
      gameStartTime: g?.startTime ? new Date(g.startTime).toISOString() : '',
      playerName: i.playerName || '',
      statType: i.statType || '',
      line: i.bettingLine ?? '',
      recommendation: i.recommendation || '',
      aiPredictedValue: predicted ?? '',
      edgePct: i.edgePercentage ?? '',
      confidence: i.confidenceScore ?? '',
      highConfidence: !!i.isHighConfidence,
      bestValue: !!i.isBestValue,
      oddsSnapshotLine: i.oddsSnapshot?.line ?? '',
      insightStatus: i.status || '',
    };
  });

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });

  const headers = [
    'insightId',
    'createdAt',
    'sport',
    'gameStatus',
    'eventId',
    'game',
    'gameStartTime',
    'playerName',
    'statType',
    'line',
    'recommendation',
    'aiPredictedValue',
    'edgePct',
    'confidence',
    'highConfidence',
    'bestValue',
    'oddsSnapshotLine',
    'insightStatus',
  ];

  const csvPath = path.join(outDir, 'insights_table.csv');
  const csvLines = [headers.join(',')];
  for (const row of rows) {
    csvLines.push(headers.map((h) => escCsv(row[h])).join(','));
  }
  fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`, 'utf8');

  const mdPath = path.join(outDir, 'insights_table.md');
  const mdLines = [];
  mdLines.push(`# Insights Table (${rows.length} rows)`);
  mdLines.push('');
  mdLines.push(`GeneratedAt: ${new Date().toISOString()}`);
  mdLines.push(`StatusFilter: ${statusFilter}`);
  mdLines.push('');
  mdLines.push(`| ${headers.join(' | ')} |`);
  mdLines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    mdLines.push(`| ${headers.map((h) => mdCell(row[h])).join(' | ')} |`);
  }
  fs.writeFileSync(mdPath, `${mdLines.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify({
    totalInsights: rows.length,
    statusFilter,
    csvPath,
    mdPath,
    sample: rows.slice(0, 5),
  }, null, 2));

  await mongoose.connection.close();
})();

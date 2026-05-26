// scripts/printLatestSoccerInsight.js
const mongoose = require('mongoose');
const Insight = require('../src/models/Insight.model');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-sports-marketplace';

async function main() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const doc = await Insight.findOne({ sport: 'soccer' }).sort({ _id: -1 }).lean();
  if (!doc) {
    console.log('No soccer insight found');
    process.exit(0);
  }
  const fields = [
    'playerName', 'statType', 'formStatAvg', 'baselineStatAvg', 'focusStatAvg',
    'goalsPerG', 'assistsPerG', 'shotsOnTargetPerG', 'formGamesCount', 'baselineGamesCount', 'edgeGamesCount',
    'processedStats', 'leagueContext', '_id', 'createdAt'
  ];
  const out = {};
  for (const f of fields) out[f] = doc[f];
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

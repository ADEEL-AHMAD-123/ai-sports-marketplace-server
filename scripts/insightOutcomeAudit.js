require('dotenv').config();

const connectDB = require('../src/config/database');
const mongoose = require('mongoose');
const InsightOutcomeService = require('../src/services/InsightOutcomeService');

async function run() {
  await connectDB();
  const output = await InsightOutcomeService.getOutcomeSummary({ includeSamples: true });

  console.log(JSON.stringify(output, null, 2));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});

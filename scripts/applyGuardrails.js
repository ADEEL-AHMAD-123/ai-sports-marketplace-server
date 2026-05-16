/**
 * scripts/applyGuardrails.js
 *
 * Proactively applies all insight guardrails to every insight in the DB.
 * Safe to run multiple times (idempotent — only patches if correction needed).
 *
 * Usage:
 *   node scripts/applyGuardrails.js [--sport nba] [--dry-run]
 *
 * Guardrails applied:
 *   1. Zero-edge   : |edge| < 0.5%  → conf ≤ 30, HC false
 *   2. Weak-edge   : |edge| < 5%    → conf ≤ 55, HC false, quality moderate
 *   3. Outlier-edge: |edge| > 80%  AND baseline < 20 → quality moderate
 *   4. HC sanity   : HC true but conf < highConfidenceThreshold → HC false
 */

require('dotenv').config({ path: `${__dirname}/../.env` });

const connectDB  = require('../src/config/database');
const Insight    = require('../src/models/Insight.model');
const { INSIGHT_STATUS } = require('../src/config/constants');

const HC_THRESHOLD = 70; // Must match StrategyService default

async function run() {
  const args    = process.argv.slice(2);
  const sport   = args.includes('--sport') ? args[args.indexOf('--sport') + 1] : null;
  const dryRun  = args.includes('--dry-run');

  await connectDB();

  const query = { status: INSIGHT_STATUS.GENERATED };
  if (sport) query.sport = sport;

  const insights = await Insight.find(query)
    .select('_id playerName statType sport edgePercentage confidenceScore isHighConfidence dataQuality baselineGamesCount')
    .lean();

  console.log(`\nRunning guardrail sweep on ${insights.length} insights${sport ? ` (sport: ${sport})` : ''}${dryRun ? ' [DRY RUN]' : ''}…`);

  let patched = 0;
  let skipped = 0;

  for (const ins of insights) {
    const absEdge  = Math.abs(ins.edgePercentage ?? 0);
    const baseline = ins.baselineGamesCount ?? 30;
    const updates  = {};

    // Guardrail 1 — zero-edge
    if (absEdge < 0.5) {
      if (ins.confidenceScore > 30) updates.confidenceScore = 30;
      if (ins.isHighConfidence)     updates.isHighConfidence = false;
      if (ins.dataQuality === 'strong') updates.dataQuality = 'moderate';
    }
    // Guardrail 2 — weak-edge
    else if (absEdge < 5) {
      if (ins.confidenceScore > 55)     updates.confidenceScore = 55;
      if (ins.isHighConfidence)         updates.isHighConfidence = false;
      if (ins.dataQuality === 'strong') updates.dataQuality = 'moderate';
    }

    // Guardrail 3 — outlier-edge (extreme + thin sample)
    if (absEdge > 80 && baseline < 20 && ins.dataQuality === 'strong') {
      updates.dataQuality = 'moderate';
    }

    // Guardrail 4 — HC sanity (HC true but conf below threshold)
    if (ins.isHighConfidence && (ins.confidenceScore ?? 0) < HC_THRESHOLD) {
      updates.isHighConfidence = false;
    }

    if (Object.keys(updates).length === 0) {
      skipped++;
      continue;
    }

    console.log(`  PATCH  ${ins.playerName} (${ins.statType}) edge:${ins.edgePercentage}% conf:${ins.confidenceScore} →`, updates);
    if (!dryRun) {
      await Insight.findByIdAndUpdate(ins._id, { $set: updates });
    }
    patched++;
  }

  console.log(`\nDone. Patched: ${patched}  |  Already correct: ${skipped}`);
  process.exit(0);
}

run().catch(err => {
  console.error('Script failed:', err.message);
  process.exit(1);
});

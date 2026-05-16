/**
 * PerformanceArchive.model.js — Lifetime accuracy ledger
 *
 * One document per sport. Stores running totals of graded outcomes (wins,
 * losses, pushes, voids) so we can DELETE old graded Insight documents to
 * keep the DB lean, WITHOUT losing the lifetime hit-rate that powers public
 * trust signals (ScoutClosings hit-rate, admin lifetime KPIs).
 *
 * LIFECYCLE
 *  - Insights live in the Insight collection while they're "fresh"
 *    (within GRADED_RETENTION_DAYS, default 90 days).
 *  - Daily cron (3am) calls PerformanceService.archiveAndPruneGraded(),
 *    which atomically:
 *      1. Aggregates graded insights older than the retention window by sport
 *      2. Increments the counters in this archive
 *      3. Deletes the original Insight documents
 *  - This collection therefore grows by only 5 docs total (one per sport).
 *
 * USAGE
 *  - getRecentSuccesses() merges archive totals into the public hit-rate
 *    so the homepage rate reflects all-time performance, not just the
 *    rolling window.
 *  - Admin Outcome page exposes these as "Lifetime" cards.
 */

const mongoose = require('mongoose');
const { SPORTS } = require('../config/constants');

const archiveSchema = new mongoose.Schema(
  {
    sport: {
      type: String,
      enum: Object.values(SPORTS),
      required: true,
      unique: true,
      index: true,
    },

    /* Lifetime counters — incremented every time graded insights get pruned */
    wins:       { type: Number, default: 0 },
    losses:     { type: Number, default: 0 },
    pushes:     { type: Number, default: 0 },
    voids:      { type: Number, default: 0 },

    /* Running stats for accuracy display */
    insightsArchived: { type: Number, default: 0 }, // total moves into archive
    sumAbsEdgeOnWins:   { type: Number, default: 0 }, // for avg-edge calc
    sumAbsEdgeOnLosses: { type: Number, default: 0 },

    /* Timestamps — useful for admin diagnostics */
    oldestArchivedAt: { type: Date, default: null }, // when oldest archived insight was originally graded
    lastArchivedAt:   { type: Date, default: null }, // when we last ran a prune
  },
  { timestamps: true }
);

archiveSchema.statics.findOrCreate = async function (sport) {
  let doc = await this.findOne({ sport });
  if (!doc) {
    doc = await this.create({ sport });
  }
  return doc;
};

const PerformanceArchive = mongoose.model('PerformanceArchive', archiveSchema);

module.exports = PerformanceArchive;

/**
 * TeamGameResult.model.js — Durable finalized-game results for team history
 *
 * WHY THIS EXISTS:
 *   The `Game` collection is ephemeral — postGameSync deletes finalized games
 *   ~30h after kickoff. That is fine for the live pipeline, but it means any
 *   feature needing recent team history (form, rest days) has nothing to read,
 *   especially for weekly sports like the NFL where the prior game is always
 *   already gone.
 *
 *   TeamGameResult is a compact, purpose-built record written when a game
 *   finalizes. It outlives the Game document and is pruned by a TTL index, so
 *   insight pipelines can compute real team form / rest days without bloating
 *   the Game collection or interfering with the grading lifecycle.
 *
 * Populated by: each sport's postGameSync result-capture step.
 * Consumed by:  sport insight pipelines (currently NFLInsightPipeline).
 */

const mongoose = require('mongoose');

// Retain ~90 days — comfortably covers the longest form window in use
// (NFL: 6 games ≈ 6–7 weeks) plus headroom.
const RETENTION_DAYS = Math.max(
  30,
  parseInt(process.env.TEAM_GAME_RESULT_RETENTION_DAYS || '90', 10)
);

const teamGameResultSchema = new mongoose.Schema(
  {
    sport:        { type: String, required: true },
    // The Odds API event id — used as the idempotent upsert key per sport.
    oddsEventId:  { type: String, required: true },
    startTime:    { type: Date,   required: true },

    homeTeamName: { type: String, default: null },
    awayTeamName: { type: String, default: null },
    homeScore:    { type: Number, default: null },
    awayScore:    { type: Number, default: null },

    capturedAt:   { type: Date,   default: Date.now },
  },
  { timestamps: true }
);

// Idempotent capture — one row per (sport, event).
teamGameResultSchema.index({ sport: 1, oddsEventId: 1 }, { unique: true });

// Per-team history lookups (most-recent-first). Two indexes so the
// `$or: [homeTeamName, awayTeamName]` query is covered on both sides.
teamGameResultSchema.index({ sport: 1, homeTeamName: 1, startTime: -1 });
teamGameResultSchema.index({ sport: 1, awayTeamName: 1, startTime: -1 });

// TTL — auto-prune old results. Documents expire RETENTION_DAYS after kickoff.
teamGameResultSchema.index(
  { startTime: 1 },
  { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 }
);

const TeamGameResult = mongoose.models.TeamGameResult
  || mongoose.model('TeamGameResult', teamGameResultSchema);

module.exports = TeamGameResult;

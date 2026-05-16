/**
 * Game.model.js — Sports game / event schema (WARM cache layer)
 *
 * Populated by the Morning Scraper cron job (8 AM daily).
 * Used to:
 *  - Show the list of today's games on the home screen
 *  - Drive the Prop Watcher cron (only fetch props for active/upcoming games)
 *  - Store post-game stats after the Post-Game Sync cron runs
 */

const mongoose = require('mongoose');
const { SPORTS } = require('../config/constants');

// ─── Game status values ────────────────────────────────────────────────────────
// "scheduled" = game hasn't started yet
// "live"      = game is currently in progress
// "final"     = game is over, final stats available
// "postponed" = game was postponed / cancelled
const GAME_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  FINAL: 'final',
  POSTPONED: 'postponed',
};

const gameSchema = new mongoose.Schema(
  {
    // ── Sport & League ─────────────────────────────────────────────────────────
    sport: {
      type: String,
      enum: Object.values(SPORTS),
      required: true,
      index: true,
    },

    // League / competition name (e.g., "NBA", "Premier League", "MLB")
    league: {
      type: String,
      required: true,
    },

    // League ID from the provider (e.g., 39 for EPL on API-Football)
    leagueId: {
      type: Number,
    },

    // League region (e.g., "England", "Spain", "Global")
    leagueRegion: {
      type: String,
    },

    // Odds API sport key (e.g., "soccer_epl" — used for fetching props)
    oddsSportKey: {
      type: String,
    },

    // The Odds API event ID — primary deduplication key and used to fetch props
    oddsEventId: {
      type: String,
      index: true,
    },

    // ID from API-Sports — used to fetch player stats
    apiSportsEventId: {
      type: String,
      index: true,
    },

    // ── Teams ─────────────────────────────────────────────────────────────────
    homeTeam: {
      name:         { type: String, required: true },
      abbreviation: String,
      apiSportsId:  Number, // API-Sports team ID — used for official logo URLs
      logoUrl:      String, // Canonical team logo URL resolved by backend
      logo:         String, // Legacy fallback field (kept for backward compatibility)
    },

    awayTeam: {
      name:         { type: String, required: true },
      abbreviation: String,
      apiSportsId:  Number,
      logoUrl:      String,
      logo:         String,
    },

    // ── Game details ──────────────────────────────────────────────────────────
    // Game start time in UTC
    startTime: {
      type: Date,
      required: true,
      index: true,
    },

    // Explicit postseason marker from provider data.
    // IMPORTANT: This is NOT inferred by date/standings heuristics.
    isPlayoff: {
      type: Boolean,
      default: false,
    },

    // Optional round label when provider exposes it (e.g. "Round 1").
    playoffRound: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(GAME_STATUS),
      default: GAME_STATUS.SCHEDULED,
      index: true,
    },

    // ── Score (populated by Post-Game Sync cron) ──────────────────────────────
    score: {
      home: { type: Number, default: null },
      away: { type: Number, default: null },
    },

    // ── Venue ─────────────────────────────────────────────────────────────────
    venue: {
      name: String,
      city: String,
    },

    // ── Props availability ────────────────────────────────────────────────────
    // Has the Prop Watcher fetched props for this game?
    hasProps: {
      type: Boolean,
      default: false,
    },

    // When were props last fetched for this game?
    propsLastFetchedAt: Date,
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary query: "Give me today's NBA games that are upcoming"
gameSchema.index({ sport: 1, startTime: 1, status: 1 });

// ─── Statics ──────────────────────────────────────────────────────────────────

/**
 * Get all upcoming/live games for a sport on a specific date.
 * Used by the Prop Watcher to avoid wasting API calls on finished games.
 *
 * @param {string} sport
 * @param {Date} date - UTC date (defaults to today)
 * @returns {Promise<Game[]>}
 */
gameSchema.statics.getActiveGames = async function (sport, date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setUTCHours(23, 59, 59, 999);

  return this.find({
    sport,
    startTime: { $gte: startOfDay, $lte: endOfDay },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).lean();
};

const Game = mongoose.model('Game', gameSchema);

module.exports = { Game, GAME_STATUS };
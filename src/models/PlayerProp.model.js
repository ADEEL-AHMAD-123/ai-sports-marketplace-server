/**
 * PlayerProp.model.js — Player proposition bet schema
 *
 * A "player prop" is a bet on a specific player's statistical performance.
 * Example: "LeBron James — Points — Over/Under 25.5"
 *
 * Populated by the Prop Watcher cron job (every 30 mins).
 * The Strategy Engine adds confidenceScore, edgePercentage, and filter tags.
 *
 * This model is the WARM cache layer for props.
 */

const mongoose = require('mongoose');
const { SPORTS, MARKET_TYPES, BET_DIRECTION } = require('../config/constants');

const playerPropSchema = new mongoose.Schema(
  {
    // ── Sport & Game reference ─────────────────────────────────────────────────
    sport: {
      type: String,
      enum: Object.values(SPORTS),
      required: true,
      index: true,
    },

    gameId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Game',
      required: true,
      index: true,
    },

    // The Odds API event ID — used for pre-flight odds checks
    oddsEventId: {
      type: String,
      required: true,
    },

    // ── Player details ─────────────────────────────────────────────────────────
    playerName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    teamName: {
      type: String,
      trim: true,
    },

    // API-Sports player ID — used to fetch player stats
    apiSportsPlayerId: {
      type: Number,
    },

    // ── Prop details ───────────────────────────────────────────────────────────

    // The stat being bet on (e.g., "points", "rebounds", "assists", "threes")
    statType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    // Market type (almost always PLAYER_PROP here)
    marketType: {
      type: String,
      enum: Object.values(MARKET_TYPES),
      default: MARKET_TYPES.PLAYER_PROP,
    },

    // ── Betting line ───────────────────────────────────────────────────────────
    // The numerical line set by the bookmaker.
    // e.g., 25.5 means you bet the player scores over or under 25.5 points
    line: {
      type: Number,
      required: true,
    },

    // The odds for OVER bet (American format)
    // American odds: +110 means bet $100 to win $110; -110 means bet $110 to win $100
    overOdds: {
      type: Number,
    },

    // The odds for UNDER bet (American format)
    underOdds: {
      type: Number,
    },

    // Which bookmaker offered this line (e.g., "DraftKings", "FanDuel", "BetMGM")
    bookmaker: {
      type: String,
    },

    // ── Strategy Engine output ─────────────────────────────────────────────────

    // Confidence score: how often the player has historically hit this prop
    // Formula: (gamesHit / gamesAnalyzed) * 100
    // Range: 0–100
    confidenceScore: {
      type: Number,
      default: null,
    },

    // Edge percentage: difference between AI-predicted value and the line
    // Formula: (aiPredictedValue - line) / line * 100
    // Positive = OVER edge, Negative = UNDER edge
    edgePercentage: {
      type: Number,
      default: null,
    },

    // AI-predicted value for this stat (calculated before sending to AI)
    aiPredictedValue: {
      type: Number,
      default: null,
    },

    // ── Smart Filter Tags ──────────────────────────────────────────────────────
    // Pre-computed by the Strategy Engine for fast frontend filtering

    // True if confidenceScore >= MIN_CONFIDENCE_HITS/CONFIDENCE_WINDOW threshold
    isHighConfidence: {
      type: Boolean,
      default: false,
      index: true,
    },

    // True if |edgePercentage| >= MIN_EDGE_PERCENTAGE
    isBestValue: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── Previous line tracking ─────────────────────────────────────────────────
    // We store the previous line to detect significant line movements.
    // A big line move often indicates sharp money (professional bettors) on one side.
    previousLine: {
      type: Number,
      default: null,
    },

    lineMovedAt: Date,

    // ── Insight reference ──────────────────────────────────────────────────────
    // If an insight has been generated for this prop, store the reference.
    // Null if no insight generated yet.
    insightId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Insight',
      default: null,
    },

    // ── Availability ──────────────────────────────────────────────────────────
    // Is this prop still available to bet? (market can close before game starts)
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },

    // When the Prop Watcher last updated this prop
    lastUpdatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Deduplication: same player + stat + event should be unique
playerPropSchema.index(
  { oddsEventId: 1, playerName: 1, statType: 1 },
  { unique: true }
);

// Filter bar queries
playerPropSchema.index({ sport: 1, isHighConfidence: 1, isAvailable: 1 });
playerPropSchema.index({ sport: 1, isBestValue: 1, isAvailable: 1 });

// Game-level queries (show all props for a specific game)
playerPropSchema.index({ gameId: 1, isAvailable: 1 });

const PlayerProp = mongoose.model('PlayerProp', playerPropSchema);

module.exports = PlayerProp;
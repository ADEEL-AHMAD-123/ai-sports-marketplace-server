/**
 * PlayerStatsSnapshot.model.js
 *
 * Stores provider raw game logs per player-season-profile so scoring/unlock paths
 * can reuse the same data without repeated upstream API calls.
 */

const mongoose = require('mongoose');
const { SPORTS } = require('../config/constants');

const playerStatsSnapshotSchema = new mongoose.Schema(
  {
    sport: {
      type: String,
      enum: Object.values(SPORTS),
      required: true,
      index: true,
    },

    // Stable key used for lookups: NBA playerId or normalized MLB player name.
    playerKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    playerName: {
      type: String,
      default: null,
      trim: true,
    },

    playerId: {
      type: Number,
      default: null,
    },

    season: {
      type: Number,
      required: true,
      index: true,
    },

    // Example: standard | pitcher
    statsProfile: {
      type: String,
      default: 'standard',
      index: true,
    },

    source: {
      type: String,
      default: null,
      trim: true,
    },

    rawStats: {
      type: Array,
      default: [],
    },

    // Last game date found in rawStats payload.
    lastGameDate: {
      type: Date,
      default: null,
    },

    // Marked true after post-game lifecycle changes; refreshed lazily on next read.
    stale: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

playerStatsSnapshotSchema.index(
  { sport: 1, playerKey: 1, season: 1, statsProfile: 1 },
  { unique: true }
);

const PlayerStatsSnapshot = mongoose.models.PlayerStatsSnapshot
  || mongoose.model('PlayerStatsSnapshot', playerStatsSnapshotSchema);

module.exports = PlayerStatsSnapshot;

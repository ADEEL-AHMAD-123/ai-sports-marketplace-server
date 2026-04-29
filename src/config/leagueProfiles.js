/**
 * leagueProfiles.js — per-league scoring and injury behavior
 *
 * Keep league-specific thresholds and scoring knobs centralized so each sport
 * can evolve independently without leaking logic into other leagues.
 */

const { MIN_EDGE_PERCENTAGE, MIN_GAMES_REQUIRED } = require('./constants');

const LEAGUE_PROFILES = {
  nba: {
    key: 'nba',
    scoring: {
      highConfidenceThreshold: 57,
      minEdgePercentage: MIN_EDGE_PERCENTAGE,
      minGamesByStatType: {
        default: MIN_GAMES_REQUIRED,
      },
      confidence: {
        maxWeight: 1.4,
        strongWeight: 1.4,
        normalWeight: 1.0,
        weakWeight: 0.7,
        strongMarginCap: 2.0,
        normalMarginCap: 0.5,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 20, score: 80 },
        { minAbsEdge: 12, score: 65 },
        { minAbsEdge: 6, score: 50 },
        { minAbsEdge: 0, score: 30 },
      ],
    },
    injury: {
      supported: true,
      provider: 'api-sports-nba',
      leagueId: 12,
    },
  },

  mlb: {
    key: 'mlb',
    scoring: {
      highConfidenceThreshold: 57,
      minEdgePercentage: MIN_EDGE_PERCENTAGE,
      minGamesByStatType: {
        default: MIN_GAMES_REQUIRED,
        pitcher_strikeouts: 3,
      },
      confidence: {
        maxWeight: 1.4,
        strongWeight: 1.4,
        normalWeight: 1.0,
        weakWeight: 0.7,
        strongMarginCap: 2.0,
        normalMarginCap: 0.5,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 20, score: 80 },
        { minAbsEdge: 12, score: 65 },
        { minAbsEdge: 6, score: 50 },
        { minAbsEdge: 0, score: 30 },
      ],
    },
    injury: {
      supported: true,
      provider: 'mlb-stats-api',
      leagueId: 1,
    },
  },
};

const DEFAULT_PROFILE = {
  key: 'default',
  scoring: {
    highConfidenceThreshold: 57,
    minEdgePercentage: MIN_EDGE_PERCENTAGE,
    minGamesByStatType: {
      default: MIN_GAMES_REQUIRED,
    },
    confidence: {
      maxWeight: 1.4,
      strongWeight: 1.4,
      normalWeight: 1.0,
      weakWeight: 0.7,
      strongMarginCap: 2.0,
      normalMarginCap: 0.5,
      normalMarginLineFactor: 0.5,
    },
    edgeToConfidenceTiers: [
      { minAbsEdge: 20, score: 80 },
      { minAbsEdge: 12, score: 65 },
      { minAbsEdge: 6, score: 50 },
      { minAbsEdge: 0, score: 30 },
    ],
  },
  injury: {
    supported: false,
    provider: null,
    leagueId: null,
  },
};

const getLeagueProfile = (sport) => LEAGUE_PROFILES[sport] || DEFAULT_PROFILE;

module.exports = {
  LEAGUE_PROFILES,
  DEFAULT_PROFILE,
  getLeagueProfile,
};

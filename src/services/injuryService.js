/**
 * injuryService.js — Thin routing layer for injury data
 *
 * Delegates to sport-specific injury services:
 *   NBA → services/sports/nba/NBAInjuryService.js  (API-Sports NBA v2)
 *   MLB → services/sports/mlb/MLBInjuryService.js  (Official MLB Stats API)
 *   NHL → services/sports/nhl/NHLInjuryService.js  (API-Sports Hockey v1)
 *
 * All callers import this file — sport-specific details stay inside each service.
 */

const NBAInjuryService = require('./sports/nba/NBAInjuryService');
const MLBInjuryService = require('./sports/mlb/MLBInjuryService');
const NHLInjuryService = require('./sports/nhl/NHLInjuryService');
const SoccerInjuryService = require('./sports/soccer/SoccerInjuryService');
const logger           = require('../config/logger');

const INJURY_SERVICES = {
  nba: NBAInjuryService,
  mlb: MLBInjuryService,
  nhl: NHLInjuryService,
  soccer: SoccerInjuryService,
};

function isInjurySportSupported(sport) {
  return sport in INJURY_SERVICES;
}

async function getInjuryStatusesForGame(gameCtx, sport) {
  const svc = INJURY_SERVICES[sport];
  if (!svc) return new Map();
  try {
    return await svc.getInjuryMap(gameCtx);
  } catch (err) {
    logger.error('[injuryService] getInjuryStatusesForGame failed', { sport, error: err.message });
    return new Map();
  }
}

async function getPlayerInjuryStatus(playerName, game, sport) {
  const svc = INJURY_SERVICES[sport];
  if (!svc) return null;
  return svc.getPlayerInjury(playerName, game).catch(() => null);
}

async function getInjuryPromptContext(playerName, game, sport) {
  const svc = INJURY_SERVICES[sport];
  if (!svc) return null;
  return svc.getInjuryPromptContext(playerName, game).catch(() => null);
}

module.exports = {
  isInjurySportSupported,
  getInjuryStatusesForGame,
  getPlayerInjuryStatus,
  getInjuryPromptContext,
};


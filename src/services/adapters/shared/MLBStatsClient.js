/**
 * MLBStatsClient.js — Official MLB Stats API client (free, no key required)
 *
 * Source: statsapi.mlb.com (MLB's official public API)
 * Used by: ESPN, FanGraphs, Baseball Reference, MLB app itself
 * Auth: None — completely public
 * Rate limits: None official — be reasonable (cache aggressively)
 *
 * ENDPOINTS USED:
 *  GET /api/v1/people/search?names={name}
 *    → Find player MLBAM ID by name
 *    → Returns: { people: [{ id, fullName, currentTeam }] }
 *
 *  GET /api/v1/people/{id}/stats?stats=gameLog&season={year}&group=hitting
 *    → Batter game log (hits, HR, RBI, TB, OBP, SLG per game)
 *    → Returns: { stats: [{ splits: [{ stat: {...}, date, opponent }] }] }
 *
 *  GET /api/v1/people/{id}/stats?stats=gameLog&season={year}&group=pitching
 *    → Pitcher game log (K, IP, ER, BB, ERA, WHIP per start)
 *
 * FIELD NAMES in stat objects:
 *  Hitting:  hits, homeRuns, rbi, runs, atBats, totalBases,
 *            baseOnBalls, strikeOuts, avg, obp, slg, ops,
 *            doubles, triples
 *  Pitching: strikeOuts, inningsPitched ("6.0"), earnedRuns,
 *            hits, baseOnBalls, era, whip, wins, losses,
 *            battersFaced, pitchesThrown
 */

const axios  = require('axios');
const logger = require('../../../config/logger');

const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

// In-memory cache — MLBAM IDs never change so cache forever
const idCache = new Map();

class MLBStatsClient {

  // ─── Player ID resolution ──────────────────────────────────────────────────

  /**
   * Find a player's MLBAM ID by name.
   * Uses in-memory cache (IDs never change).
   *
   * @param {string} playerName - Full name e.g. "Aaron Judge"
   * @returns {Promise<number|null>} MLBAM player ID
   */
  async findPlayerId(playerName) {
    const norm = playerName.trim().toLowerCase();

    if (idCache.has(norm)) return idCache.get(norm);

    try {
      // Try exact full name first
      const results = await this._searchByName(playerName);
      if (results.length > 0) {
        const best = this._bestNameMatch(playerName, results);
        if (best) {
          idCache.set(norm, best.id);
          logger.debug(`[MLBStats] Resolved: "${playerName}" → ${best.id} (${best.fullName})`);
          return best.id;
        }
      }

      // Fallback: search by last name only
      const parts    = playerName.trim().split(' ');
      const lastName = parts[parts.length - 1];
      if (lastName.length >= 3) {
        const fallback = await this._searchByName(lastName);
        const best     = this._bestNameMatch(playerName, fallback);
        if (best) {
          idCache.set(norm, best.id);
          logger.debug(`[MLBStats] Resolved via last name: "${playerName}" → ${best.id}`);
          return best.id;
        }
      }

      logger.warn(`[MLBStats] Could not find MLBAM ID for: "${playerName}"`);
      return null;
    } catch (err) {
      logger.error(`[MLBStats] findPlayerId failed for "${playerName}"`, { error: err.message });
      return null;
    }
  }

  async _searchByName(name) {
    // Strip special chars that break MLB API search
    const clean = name.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    try {
      const res = await axios.get(`${MLB_API_BASE}/people/search`, {
        params: { names: clean },
        timeout: 8000,
      });
      return res.data?.people || [];
    } catch (err) {
      if (err.response?.status === 404) return [];
      throw err;
    }
  }

  _bestNameMatch(targetName, people) {
    const target = targetName.toLowerCase().replace(/[^a-z ]/g, '');
    for (const p of people) {
      const full = (p.fullName || '').toLowerCase().replace(/[^a-z ]/g, '');
      if (full === target) return p; // exact match
    }
    // Fuzzy: last name match
    const targetLast = target.split(' ').pop();
    return people.find(p => {
      const pLast = (p.fullName || '').toLowerCase().split(' ').pop().replace(/[^a-z]/g, '');
      return pLast === targetLast;
    }) || people[0] || null;
  }

  // ─── Game logs ─────────────────────────────────────────────────────────────

  /**
   * Get batter game log for a player.
   *
   * @param {number} mlbamId    - MLBAM player ID
   * @param {number} season     - Year e.g. 2025
   * @returns {Promise<Array>}  Array of game stat objects, newest last
   */
  async getBatterGameLog(mlbamId, season) {
    return this._getGameLog(mlbamId, season, 'hitting');
  }

  /**
   * Get pitcher game log for a player.
   */
  async getPitcherGameLog(mlbamId, season) {
    return this._getGameLog(mlbamId, season, 'pitching');
  }

  async _getGameLog(mlbamId, season, group) {
    try {
      const res = await axios.get(`${MLB_API_BASE}/people/${mlbamId}/stats`, {
        params: { stats: 'gameLog', season, group },
        timeout: 10000,
      });

      const splits = res.data?.stats?.[0]?.splits || [];
      // splits are oldest→newest — return as-is (formulas use .slice(-N))
      return splits.map(s => ({
        ...s.stat,
        date:     s.date,
        opponent: s.opponent?.name || null,
        gameId:   s.game?.gamePk || null,
        isHome:   s.isHome,
      }));
    } catch (err) {
      if (err.response?.status === 404) return [];
      logger.error(`[MLBStats] getGameLog failed`, { mlbamId, season, group, error: err.message });
      return [];
    }
  }

  /**
   * Get full stats for a player (batter + pitcher) by name.
   * Used by MLBAdapter.fetchPlayerStats.
   *
   * @param {string}  playerName
   * @param {boolean} isPitcher
   * @param {number}  season
   * @returns {Promise<Array|null>} Game log array or null
   */
  async getPlayerStats(playerName, isPitcher = false, season = null) {
    const yr    = season || new Date().getFullYear();
    const mlbId = await this.findPlayerId(playerName);
    if (!mlbId) return null;

    const games = isPitcher
      ? await this.getPitcherGameLog(mlbId, yr)
      : await this.getBatterGameLog(mlbId, yr);

    if (!games.length) {
      logger.debug(`[MLBStats] No ${yr} game log for "${playerName}" (mlbId=${mlbId})`);
    } else {
      logger.info(`[MLBStats] ${games.length} games for "${playerName}" (mlbId=${mlbId})`);
    }

    return games;
  }

  // ─── Person details (for platoon service) ────────────────────────────────

  /**
   * Get person details including pitchHand and batSide.
   * Used by MLBPlatoonService to get pitcher throwing hand and batter batting side.
   *
   * @param {number} mlbamId
   * @returns {Promise<{ pitchHand: { code: string }, batSide: { code: string } }|null>}
   */
  async _getPersonDetails(mlbamId) {
    if (!mlbamId) return null;
    try {
      const res = await axios.get(`${MLB_API_BASE}/people/${mlbamId}`, {
        params: { fields: 'people,id,fullName,pitchHand,batSide' },
        timeout: 8000,
      });
      return res.data?.people?.[0] || null;
    } catch (err) {
      if (err.response?.status === 404) return null;
      logger.error('[MLBStats] _getPersonDetails failed', { mlbamId, error: err.message });
      return null;
    }
  }

  /**
   * Get stat splits for a player (vs LHP / vs RHP for batters).
   * Used by MLBPlatoonService.fetchBatterSplits().
   *
   * @param {number} mlbamId
   * @param {number} season
   * @param {string} group  - 'hitting' | 'pitching'
   * @returns {Promise<Array>} Array of split objects
   */
  async _getStatSplits(mlbamId, season, group = 'hitting') {
    if (!mlbamId) return [];
    try {
      const res = await axios.get(`${MLB_API_BASE}/people/${mlbamId}/stats`, {
        params: {
          stats:  'statSplits',
          season,
          group,
          gameType: 'R',  // Regular season only
        },
        timeout: 10000,
      });
      // statSplits returns multiple stat objects — find the one with splits
      const stats = res.data?.stats || [];
      for (const stat of stats) {
        if (stat.splits?.length) return stat.splits;
      }
      return [];
    } catch (err) {
      if (err.response?.status === 404) return [];
      logger.error('[MLBStats] _getStatSplits failed', { mlbamId, season, group, error: err.message });
      return [];
    }
  }


  // ─── Team lookups (for injury service) ────────────────────────────────────

  /**
   * Get MLB team ID by team name.
   * Uses /teams endpoint with sportId=1 (MLB).
   *
   * @param {string} teamName - e.g. "Los Angeles Dodgers"
   * @returns {Promise<number|null>} MLB team ID
   */
  async getTeamIdByName(teamName) {
    const norm = teamName?.trim().toLowerCase();
    if (!norm) return null;

    // Check in-memory cache first (team IDs never change)
    for (const [key, id] of idCache.entries()) {
      if (key === `team:${norm}`) return id;
    }

    try {
      const res = await axios.get(`${MLB_API_BASE}/teams`, {
        params: { sportId: 1, season: new Date().getFullYear() },
        timeout: 8000,
      });

      const teams = res.data?.teams || [];
      for (const t of teams) {
        const match = t.name?.toLowerCase() === norm
          || t.teamName?.toLowerCase() === norm
          || t.locationName?.toLowerCase() + ' ' + t.teamName?.toLowerCase() === norm;

        if (match) {
          idCache.set(`team:${norm}`, t.id);
          return t.id;
        }
      }

      // Fuzzy: check if team name contains any word from our query
      const words = norm.split(' ').filter(w => w.length > 3);
      const fuzzy = teams.find(t =>
        words.some(w => t.name?.toLowerCase().includes(w))
      );
      if (fuzzy) {
        idCache.set(`team:${norm}`, fuzzy.id);
        return fuzzy.id;
      }

      logger.warn(`[MLBStats] Team not found: "${teamName}"`);
      return null;
    } catch (err) {
      logger.error(`[MLBStats] getTeamIdByName failed for "${teamName}"`, { error: err.message });
      return null;
    }
  }

  /**
   * Get injured list roster for a team.
   * Uses /teams/{teamId}/roster?rosterType=injured (official MLB API).
   *
   * Response: { roster: [{ person: { id, fullName }, status: { description } }] }
   *
   * @param {number} teamId - MLB team ID
   * @returns {Promise<Array>} Array of injury roster entries
   */
  async getInjuredListForTeam(teamId) {
    if (!teamId) return [];
    try {
      const res = await axios.get(`${MLB_API_BASE}/teams/${teamId}/roster`, {
        params: { rosterType: 'injured' },
        timeout: 8000,
      });
      return res.data?.roster || [];
    } catch (err) {
      if (err.response?.status === 404) return [];
      logger.error(`[MLBStats] getInjuredListForTeam failed`, { teamId, error: err.message });
      return [];
    }
  }

}

// Singleton
module.exports = new MLBStatsClient();
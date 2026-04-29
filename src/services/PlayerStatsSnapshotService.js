/**
 * PlayerStatsSnapshotService
 *
 * Read order:
 *   Redis snapshot cache -> Mongo snapshot -> provider fetch (if missing/stale)
 *
 * Refresh policy:
 *   - Event-based invalidation via post-game lifecycle (stale=true)
 *   - Lazy refresh when stale snapshot is requested
 */

const { cacheGet, cacheSet } = require('../config/redis');
const { getAdapter } = require('./adapters/adapterRegistry');
const PlayerStatsSnapshot = require('../models/PlayerStatsSnapshot.model');
const logger = require('../config/logger');
const mongoose = require('mongoose');

const SNAPSHOT_CACHE_TTL_SECONDS = parseInt(process.env.PLAYER_STATS_SNAPSHOT_TTL_SECONDS || '21600', 10); // 6h

const normalizePlayerNameKey = (name = '') => String(name)
  .toLowerCase()
  .replace(/['.\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const getSeasonForSport = (sport, now = new Date()) => {
  if (sport === 'nba') {
    const year = now.getFullYear();
    return (now.getMonth() + 1) >= 10 ? year : year - 1;
  }
  return now.getFullYear();
};

const extractLatestGameDate = (stats = []) => {
  if (!Array.isArray(stats) || !stats.length) return null;

  let latest = null;
  for (const row of stats) {
    const maybeDate = row?.date || row?.game?.date || row?.game?.start || row?.game?.datetime;
    if (!maybeDate) continue;

    const parsed = new Date(maybeDate);
    if (!Number.isNaN(parsed.getTime()) && (!latest || parsed > latest)) {
      latest = parsed;
    }
  }
  return latest;
};

class PlayerStatsSnapshotService {
  _isMongoReady() {
    return mongoose?.connection?.readyState === 1;
  }

  _buildLookup({ sport, playerName, playerId, season, isPitcher = false }) {
    const resolvedSeason = Number(season || getSeasonForSport(sport));
    const statsProfile = sport === 'mlb' && isPitcher ? 'pitcher' : 'standard';
    const playerKey = sport === 'nba'
      ? (playerId ? `id:${playerId}` : null)
      : normalizePlayerNameKey(playerName); // mlb + nhl both look up by name

    return {
      sport,
      season: resolvedSeason,
      statsProfile,
      playerKey,
      playerName: playerName || null,
      playerId: playerId || null,
    };
  }

  _snapshotCacheKey({ sport, season, statsProfile, playerKey }) {
    return `playerstats:snapshot:${sport}:${season}:${statsProfile}:${playerKey}`;
  }

  async getPlayerStats(params) {
    const lookup = this._buildLookup(params);
    if (!lookup.playerKey) return [];

    const cacheKey = this._snapshotCacheKey(lookup);
    const cached = await cacheGet(cacheKey);
    if (cached?.length >= 0) return cached;

    const mongoReady = this._isMongoReady();

    const existing = mongoReady
      ? await PlayerStatsSnapshot.findOne({
        sport: lookup.sport,
        playerKey: lookup.playerKey,
        season: lookup.season,
        statsProfile: lookup.statsProfile,
      }).lean()
      : null;

    if (existing && !existing.stale && Array.isArray(existing.rawStats)) {
      await cacheSet(cacheKey, existing.rawStats, SNAPSHOT_CACHE_TTL_SECONDS);
      return existing.rawStats;
    }

    const fetched = await this._fetchFromProvider(params, lookup);

    // If refresh fails but we had a snapshot, return that snapshot to keep pipeline running.
    if ((!fetched || !fetched.length) && existing?.rawStats?.length) {
      await cacheSet(cacheKey, existing.rawStats, SNAPSHOT_CACHE_TTL_SECONDS);
      return existing.rawStats;
    }

    const rawStats = Array.isArray(fetched) ? fetched : [];
    const latestGameDate = extractLatestGameDate(rawStats);

    if (mongoReady) {
      await PlayerStatsSnapshot.findOneAndUpdate(
        {
          sport: lookup.sport,
          playerKey: lookup.playerKey,
          season: lookup.season,
          statsProfile: lookup.statsProfile,
        },
        {
          $set: {
            playerName: lookup.playerName,
            playerId: lookup.playerId,
            source: lookup.sport === 'nba' ? 'api-sports-nba' : lookup.sport === 'nhl' ? 'api-sports-hockey' : 'mlb-stats-api',
            rawStats,
            lastGameDate: latestGameDate,
            stale: false,
          },
        },
        { upsert: true }
      );
    }

    await cacheSet(cacheKey, rawStats, SNAPSHOT_CACHE_TTL_SECONDS);
    return rawStats;
  }

  async _fetchFromProvider(params, lookup) {
    try {
      const adapter = getAdapter(lookup.sport);
      if (lookup.sport === 'mlb') {
        return await adapter.fetchPlayerStats({
          playerName: params.playerName,
          season: lookup.season,
          isPitcher: lookup.statsProfile === 'pitcher',
        });
      }

      if (lookup.sport === 'nhl') {
        return await adapter.fetchPlayerStats({
          playerName: params.playerName,
          season: lookup.season,
        });
      }

      if (!lookup.playerId) return [];
      return await adapter.fetchPlayerStats({
        playerId: lookup.playerId,
        season: lookup.season,
      });
    } catch (err) {
      logger.warn('[PlayerStatsSnapshotService] Provider fetch failed', {
        sport: lookup.sport,
        playerKey: lookup.playerKey,
        season: lookup.season,
        statsProfile: lookup.statsProfile,
        error: err.message,
      });
      return [];
    }
  }

  async markSportSnapshotsStale(sport) {
    if (!this._isMongoReady()) return 0;

    const result = await PlayerStatsSnapshot.updateMany(
      { sport, stale: false },
      { $set: { stale: true } }
    );

    logger.info('[PlayerStatsSnapshotService] Marked snapshots stale', {
      sport,
      modified: result.modifiedCount || 0,
    });

    return result.modifiedCount || 0;
  }
}

module.exports = new PlayerStatsSnapshotService();

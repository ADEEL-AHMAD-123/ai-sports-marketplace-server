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
const { getAdapter } = require('./shared/adapterRegistry');
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

  _buildLookup({ sport, playerName, playerId, season, isPitcher = false, leagueId = null }) {
    const resolvedSeason = Number(season || getSeasonForSport(sport));
    const statsProfile = sport === 'mlb' && isPitcher ? 'pitcher' : 'standard';

    let playerKey;
    if (sport === 'nba' || sport === 'nfl') {
      // ID-based sports: stable key regardless of opponent
      playerKey = playerId ? `id:${playerId}` : null;
    } else if (sport === 'soccer') {
      // Name-based, scoped per league so EPL and La Liga don't share a cache slot
      const normName = normalizePlayerNameKey(playerName);
      playerKey = normName
        ? (leagueId ? `${normName}:league:${leagueId}` : normName)
        : null;
    } else {
      // mlb, nhl — name-based
      playerKey = normalizePlayerNameKey(playerName) || null;
    }

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
      const sourceMap = {
        nba:    'api-sports-nba',
        nfl:    'api-sports-nfl',
        nhl:    'nhl-official',
        mlb:    'mlb-stats-api',
        soccer: 'api-sports-soccer',
      };
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
            source: sourceMap[lookup.sport] || lookup.sport,
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
        // Pass team names so the NHL roster resolver can identify the player
        return await adapter.fetchPlayerStats({
          playerName: params.playerName,
          homeTeamName: params.homeTeamName || null,
          awayTeamName: params.awayTeamName || null,
          season: lookup.season,
        });
      }

      if (lookup.sport === 'soccer') {
        return await adapter.fetchPlayerStats({
          playerName: params.playerName,
          homeTeamName: params.homeTeamName || null,
          awayTeamName: params.awayTeamName || null,
          leagueId: params.leagueId || null,
        });
      }

      // NBA and NFL — require playerId
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

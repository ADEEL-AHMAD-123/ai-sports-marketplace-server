const mockMongoose = {
  connection: {
    readyState: 1,
  },
};

jest.mock('mongoose', () => mockMongoose);
jest.mock('../../src/config/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));
jest.mock('../../src/services/shared/adapterRegistry', () => ({
  getAdapter: jest.fn(),
}));
jest.mock('../../src/models/PlayerStatsSnapshot.model', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { cacheGet, cacheSet } = require('../../src/config/redis');
const { getAdapter } = require('../../src/services/shared/adapterRegistry');
const PlayerStatsSnapshot = require('../../src/models/PlayerStatsSnapshot.model');
const PlayerStatsSnapshotService = require('../../src/services/PlayerStatsSnapshotService');

describe('PlayerStatsSnapshotService', () => {
  const mockAdapter = {
    fetchPlayerStats: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockMongoose.connection.readyState = 1;
    getAdapter.mockReturnValue(mockAdapter);
    cacheSet.mockResolvedValue(true);
    PlayerStatsSnapshot.findOneAndUpdate.mockResolvedValue({});
    PlayerStatsSnapshot.updateMany.mockResolvedValue({ modifiedCount: 3 });
  });

  it('returns Redis-cached stats without hitting Mongo or provider', async () => {
    const cachedStats = [{ date: '2026-01-12', points: 28 }];
    cacheGet.mockResolvedValue(cachedStats);

    const result = await PlayerStatsSnapshotService.getPlayerStats({
      sport: 'nba',
      playerId: 2544,
    });

    expect(result).toEqual(cachedStats);
    expect(cacheGet).toHaveBeenCalledWith(expect.stringContaining('playerstats:snapshot:nba:'));
    expect(PlayerStatsSnapshot.findOne).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('returns Mongo snapshot and backfills Redis when snapshot is fresh', async () => {
    const mongoStats = [{ date: '2026-01-10', points: 24 }];
    cacheGet.mockResolvedValue(null);
    PlayerStatsSnapshot.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ stale: false, rawStats: mongoStats }),
    });

    const result = await PlayerStatsSnapshotService.getPlayerStats({
      sport: 'nba',
      playerId: 2544,
      season: 2025,
    });

    expect(result).toEqual(mongoStats);
    expect(getAdapter).not.toHaveBeenCalled();
    expect(cacheSet).toHaveBeenCalledWith(
      'playerstats:snapshot:nba:2025:standard:id:2544',
      mongoStats,
      21600
    );
  });

  it('falls back to stale Mongo snapshot when provider refresh returns no stats', async () => {
    const staleStats = [{ date: '2026-01-08', rebounds: 11 }];
    cacheGet.mockResolvedValue(null);
    PlayerStatsSnapshot.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ stale: true, rawStats: staleStats }),
    });
    mockAdapter.fetchPlayerStats.mockResolvedValue([]);

    const result = await PlayerStatsSnapshotService.getPlayerStats({
      sport: 'nba',
      playerId: 203999,
      season: 2025,
    });

    expect(result).toEqual(staleStats);
    expect(mockAdapter.fetchPlayerStats).toHaveBeenCalledWith({ playerId: 203999, season: 2025 });
    expect(PlayerStatsSnapshot.findOneAndUpdate).not.toHaveBeenCalled();
    expect(cacheSet).toHaveBeenCalledWith(
      'playerstats:snapshot:nba:2025:standard:id:203999',
      staleStats,
      21600
    );
  });

  it('fetches provider stats and persists MLB pitcher snapshots on miss', async () => {
    const fetchedStats = [
      { game: { date: '2026-04-01T00:00:00.000Z' }, strikeouts: 7 },
      { game: { date: '2026-04-05T00:00:00.000Z' }, strikeouts: 9 },
    ];
    cacheGet.mockResolvedValue(null);
    PlayerStatsSnapshot.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    mockAdapter.fetchPlayerStats.mockResolvedValue(fetchedStats);

    const result = await PlayerStatsSnapshotService.getPlayerStats({
      sport: 'mlb',
      playerName: 'Zack Wheeler',
      season: 2026,
      isPitcher: true,
    });

    expect(result).toEqual(fetchedStats);
    expect(mockAdapter.fetchPlayerStats).toHaveBeenCalledWith({
      playerName: 'Zack Wheeler',
      season: 2026,
      isPitcher: true,
    });
    expect(PlayerStatsSnapshot.findOneAndUpdate).toHaveBeenCalledWith(
      {
        sport: 'mlb',
        playerKey: 'zack wheeler',
        season: 2026,
        statsProfile: 'pitcher',
      },
      {
        $set: expect.objectContaining({
          playerName: 'Zack Wheeler',
          playerId: null,
          source: 'mlb-stats-api',
          rawStats: fetchedStats,
          stale: false,
          lastGameDate: new Date('2026-04-05T00:00:00.000Z'),
        }),
      },
      { upsert: true }
    );
  });

  it('skips Mongo writes when connection is not ready', async () => {
    mockMongoose.connection.readyState = 0;
    cacheGet.mockResolvedValue(null);
    mockAdapter.fetchPlayerStats.mockResolvedValue([{ points: 18 }]);

    const result = await PlayerStatsSnapshotService.getPlayerStats({
      sport: 'nba',
      playerId: 777,
      season: 2025,
    });

    expect(result).toEqual([{ points: 18 }]);
    expect(PlayerStatsSnapshot.findOne).not.toHaveBeenCalled();
    expect(PlayerStatsSnapshot.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns zero stale updates when Mongo is disconnected', async () => {
    mockMongoose.connection.readyState = 0;

    const result = await PlayerStatsSnapshotService.markSportSnapshotsStale('mlb');

    expect(result).toBe(0);
    expect(PlayerStatsSnapshot.updateMany).not.toHaveBeenCalled();
  });
});
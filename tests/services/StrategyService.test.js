jest.mock('../../src/models/PlayerProp.model', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../src/services/PlayerStatsSnapshotService', () => ({
  getPlayerStats: jest.fn(),
}));
jest.mock('../../src/services/shared/adapterRegistry', () => ({
  getAdapter: jest.fn(),
}));
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const PlayerProp = require('../../src/models/PlayerProp.model');
const PlayerStatsSnapshotService = require('../../src/services/PlayerStatsSnapshotService');
const { getAdapter } = require('../../src/services/shared/adapterRegistry');
const StrategyService = require('../../src/services/StrategyService');

describe('StrategyService', () => {
  const mockStats = [
    { points: 31 }, { points: 29 }, { points: 27 },
    { points: 33 }, { points: 25 }, { points: 26 },
    { points: 30 }, { points: 28 },
  ];

  const mockAdapter = {
    applyFormulas: jest.fn().mockReturnValue({
      recentStatValues: [30, 28, 27, 31, 26],
      focusStatAvg: 28.4,
    }),
    fetchPlayerStats: jest.fn().mockResolvedValue(mockStats),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getAdapter.mockReturnValue(mockAdapter);
  });

  it('fetches stats once per unique NBA player across multiple props', async () => {
    const props = [
      {
        _id: 'prop-1',
        sport: 'nba',
        isAvailable: true,
        playerName: 'LeBron James',
        apiSportsPlayerId: 2544,
        statType: 'points',
        line: 25.5,
      },
      {
        _id: 'prop-2',
        sport: 'nba',
        isAvailable: true,
        playerName: 'LeBron James',
        apiSportsPlayerId: 2544,
        statType: 'assists',
        line: 7.5,
      },
      {
        _id: 'prop-3',
        sport: 'nba',
        isAvailable: true,
        playerName: 'Stephen Curry',
        apiSportsPlayerId: 115,
        statType: 'threes',
        line: 4.5,
      },
    ];

    PlayerProp.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(props),
      }),
    });

    PlayerStatsSnapshotService.getPlayerStats.mockResolvedValue(mockStats);
    PlayerProp.bulkWrite = jest.fn().mockResolvedValue({});

    const result = await StrategyService.scoreAllPropsForSport('nba');

    // New behaviour: PlayerStatsSnapshotService is called once per unique fetch key.
    // LeBron has 2 props but same playerId, so grouped into one fetch + Curry = 2 total.
    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenCalledTimes(2);
    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenCalledWith({ sport: 'nba', playerId: 2544 });
    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenCalledWith({ sport: 'nba', playerId: 115 });
    expect(result).toEqual(expect.objectContaining({ failed: 0 }));
  });

  it('uses league-profile confidence margins for NBA lines', () => {
    const result = StrategyService.computeScores(
      {
        focusStatAvg: 28.4,
        recentStatValues: [30, 28, 27, 31, 26],
      },
      25.5,
      { sport: 'nba', statType: 'points' }
    );

    // NBA profile uses wider strong/normal margins, so this lands at 74.
    expect(result.confidenceScore).toBe(74);
    expect(result.isHighConfidence).toBe(true);
  });

  it('uses sport-specific edge-to-confidence tiers on fallback', () => {
    const result = StrategyService.computeScores(
      { focusStatAvg: 0.65, recentStatValues: [] },
      0.5,
      { sport: 'mlb', statType: 'hits' }
    );

    // 30% edge should map to MLB tier score 82.
    expect(result.confidenceScore).toBe(82);
  });
});
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
  const mockAdapter = {
    applyFormulas: jest.fn().mockReturnValue({
      recentStatValues: [30, 28, 27, 31, 26],
      focusStatAvg: 28.4,
    }),
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
      lean: jest.fn().mockResolvedValue(props),
    });
    PlayerStatsSnapshotService.getPlayerStats
      .mockResolvedValueOnce([
        { points: 31 },
        { points: 29 },
        { points: 27 },
        { points: 33 },
        { points: 25 },
        { points: 26 },
        { points: 30 },
        { points: 28 },
      ])
      .mockResolvedValueOnce([
        { threes: 5 },
        { threes: 6 },
        { threes: 4 },
        { threes: 7 },
        { threes: 5 },
        { threes: 4 },
        { threes: 6 },
        { threes: 5 },
      ]);

    const result = await StrategyService.scoreAllPropsForSport('nba');

    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenCalledTimes(2);
    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenNthCalledWith(1, {
      sport: 'nba',
      playerName: 'LeBron James',
      playerId: 2544,
      isPitcher: false,
    });
    expect(PlayerStatsSnapshotService.getPlayerStats).toHaveBeenNthCalledWith(2, {
      sport: 'nba',
      playerName: 'Stephen Curry',
      playerId: 115,
      isPitcher: false,
    });
    expect(result).toEqual(expect.objectContaining({ failed: 0 }));
  });
});
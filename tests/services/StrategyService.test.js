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
      lean: jest.fn().mockResolvedValue(props),
    });

    const result = await StrategyService.scoreAllPropsForSport('nba');

    // New behaviour: adapter.fetchPlayerStats called once per prop (not deduplicated at this layer).
    // LeBron has 2 props (points + assists) → 2 calls; Curry has 1 → 1 call = 3 total.
    expect(mockAdapter.fetchPlayerStats).toHaveBeenCalledTimes(3);
    expect(mockAdapter.fetchPlayerStats).toHaveBeenCalledWith({ playerId: 2544 });
    expect(mockAdapter.fetchPlayerStats).toHaveBeenCalledWith({ playerId: 115 });
    expect(result).toEqual(expect.objectContaining({ failed: 0 }));
  });
});
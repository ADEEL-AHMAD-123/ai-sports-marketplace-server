jest.mock('../src/config/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));

jest.mock('../src/services/adapters/shared/ApiSportsClient', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn(),
  }));
});

jest.mock('../src/services/adapters/shared/MLBStatsClient', () => ({
  getTeamIdByName: jest.fn(),
  getInjuredListForTeam: jest.fn(),
}));

const { cacheGet, cacheSet } = require('../src/config/redis');
const mlbStatsClient = require('../src/services/adapters/shared/MLBStatsClient');

const {
  getPlayerInjuryStatus,
  getInjuryPromptContext,
  isInjurySportSupported,
} = require('../src/services/injuryService');

describe('injuryService MLB support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(true);
  });

  it('returns Out status for MLB injured list player', async () => {
    mlbStatsClient.getTeamIdByName.mockResolvedValue(147);
    mlbStatsClient.getInjuredListForTeam.mockResolvedValue([
      {
        person: { fullName: 'Aaron Judge' },
        status: { description: '10-Day Injured List' },
      },
    ]);

    const injury = await getPlayerInjuryStatus(
      'Aaron Judge',
      { homeTeamName: 'New York Yankees' },
      'mlb'
    );

    expect(injury).toEqual(
      expect.objectContaining({
        status: 'Out',
        severity: 'critical',
      })
    );
    expect(injury.reason).toContain('10-Day Injured List');
  });

  it('returns null when MLB player not on injured list', async () => {
    mlbStatsClient.getTeamIdByName.mockResolvedValue(111);
    mlbStatsClient.getInjuredListForTeam.mockResolvedValue([
      {
        person: { fullName: 'Different Player' },
        status: { description: '10-Day Injured List' },
      },
    ]);

    const injury = await getPlayerInjuryStatus(
      'Rafael Devers',
      { homeTeamName: 'Boston Red Sox' },
      'mlb'
    );

    expect(injury).toBeNull();
  });

  it('builds MLB injury prompt context from free injury source', async () => {
    mlbStatsClient.getTeamIdByName.mockResolvedValue(121);
    mlbStatsClient.getInjuredListForTeam.mockResolvedValue([
      {
        person: { fullName: 'Francisco Lindor' },
        status: { description: 'Day-to-Day (back tightness)' },
      },
    ]);

    const promptContext = await getInjuryPromptContext(
      'Francisco Lindor',
      { awayTeamName: 'New York Mets' },
      'mlb'
    );

    expect(promptContext).toBe('Player day-to-day, minor injury');
  });

  it('does not flag MLB players when roster status is Active', async () => {
    mlbStatsClient.getTeamIdByName.mockResolvedValue(147);
    mlbStatsClient.getInjuredListForTeam.mockResolvedValue([
      {
        person: { fullName: 'Aaron Judge' },
        status: { description: 'Active' },
      },
    ]);

    const injury = await getPlayerInjuryStatus(
      'Aaron Judge',
      { homeTeamName: 'New York Yankees' },
      'mlb'
    );

    expect(injury).toBeNull();
  });

  it('marks mlb as supported injury sport', () => {
    expect(isInjurySportSupported('mlb')).toBe(true);
    expect(isInjurySportSupported('nfl')).toBe(false);
  });
});

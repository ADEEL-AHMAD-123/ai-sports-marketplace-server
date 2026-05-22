/**
 * NFLAdapter.test.js — score-feed parsing
 *
 * fetchFinalScores parses The Odds API /scores payload. Pinning the shape
 * here guards the result-capture pipeline (TeamGameResult) against silent
 * parsing regressions.
 */

jest.mock('axios');
jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const NFLAdapter = require('../../../src/services/sports/nfl/NFLAdapter');

describe('NFLAdapter.fetchFinalScores', () => {
  let adapter;
  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new NFLAdapter();
  });

  const PAYLOAD = [
    {
      id: 'evt_completed',
      completed: true,
      home_team: 'Kansas City Chiefs',
      away_team: 'Buffalo Bills',
      scores: [
        { name: 'Kansas City Chiefs', score: '30' },
        { name: 'Buffalo Bills', score: '20' },
      ],
    },
    {
      id: 'evt_inprogress',
      completed: false,
      home_team: 'Dallas Cowboys',
      away_team: 'Philadelphia Eagles',
      scores: null,
    },
    {
      id: 'evt_completed_2',
      completed: true,
      home_team: 'Green Bay Packers',
      away_team: 'Chicago Bears',
      scores: [
        { name: 'Green Bay Packers', score: '14' },
        { name: 'Chicago Bears', score: '17' },
      ],
    },
  ];

  it('maps completed games to numeric home/away scores', async () => {
    axios.get.mockResolvedValue({ data: PAYLOAD, headers: {} });

    const result = await adapter.fetchFinalScores({ daysFrom: 3 });

    expect(result).toContainEqual({
      eventId: 'evt_completed',
      completed: true,
      homeTeam: 'Kansas City Chiefs',
      awayTeam: 'Buffalo Bills',
      homeScore: 30,
      awayScore: 20,
    });
  });

  it('returns null scores for games without a posted score', async () => {
    axios.get.mockResolvedValue({ data: PAYLOAD, headers: {} });

    const result = await adapter.fetchFinalScores();
    const inProgress = result.find((g) => g.eventId === 'evt_inprogress');

    expect(inProgress.completed).toBe(false);
    expect(inProgress.homeScore).toBeNull();
    expect(inProgress.awayScore).toBeNull();
  });

  it('fetchFinalEventIds returns only completed event ids', async () => {
    axios.get.mockResolvedValue({ data: PAYLOAD, headers: {} });

    const ids = await adapter.fetchFinalEventIds();
    expect(ids).toEqual(['evt_completed', 'evt_completed_2']);
  });

  it('returns an empty array when the scores request fails', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    const result = await adapter.fetchFinalScores();
    expect(result).toEqual([]);
  });
});

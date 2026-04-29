/**
 * NBAAdapter.test.js — Unit tests for NBA formula calculations
 *
 * Tests the formula engine in isolation so we catch regressions.
 * If TS% or edge calculations break, AI insights will be based on wrong data.
 */

const NBAAdapter = require('../src/services/adapters/nba/NBAAdapter');

describe('NBAAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new NBAAdapter();
  });

  // ── applyFormulas ─────────────────────────────────────────────────────────

  describe('applyFormulas()', () => {
    const mockGameStats = [
      // 5 game logs — each represents one game's stats
      { points: 30, fgm: 11, fga: 20, ftm: 6, fta: 8, tpm: 2, tpa: 5, totReb: 8, assists: 7, turnovers: 3, min: '35' },
      { points: 25, fgm: 9,  fga: 18, ftm: 5, fta: 6, tpm: 2, tpa: 4, totReb: 9, assists: 8, turnovers: 2, min: '34' },
      { points: 28, fgm: 10, fga: 19, ftm: 6, fta: 7, tpm: 2, tpa: 5, totReb: 7, assists: 6, turnovers: 4, min: '36' },
      { points: 32, fgm: 12, fga: 22, ftm: 6, fta: 8, tpm: 2, tpa: 6, totReb: 10, assists: 9, turnovers: 3, min: '38' },
      { points: 22, fgm: 8,  fga: 17, ftm: 4, fta: 5, tpm: 2, tpa: 4, totReb: 6,  assists: 5, turnovers: 2, min: '32' },
    ];

    it('should calculate avgPoints correctly', () => {
      const result = adapter.applyFormulas(mockGameStats, 'points');
      // (30+25+28+32+22) / 5 = 27.4
      expect(result.avgPoints).toBe(27.4);
    });

    it('should calculate True Shooting % (TS%) correctly', () => {
      const result = adapter.applyFormulas(mockGameStats, 'points');
      // TS% = PTS / (2 * (FGA + 0.44 * FTA))
      // Total PTS = 137, FGA = 96, FTA = 34
      // TS% = 137 / (2 * (96 + 0.44 * 34)) = 137 / (2 * (96 + 14.96)) = 137 / 221.92
      const expected = parseFloat((137 / (2 * (96 + 0.44 * 34)) * 100).toFixed(1));
      expect(result.trueShootingPct).toBe(expected);
    });

    it('should calculate eFG% correctly', () => {
      const result = adapter.applyFormulas(mockGameStats, 'points');
      // eFG% = (FGM + 0.5 * 3PM) / FGA
      // FGM = 50, 3PM = 10, FGA = 96
      // eFG% = (50 + 0.5 * 10) / 96 = 55 / 96
      const expected = parseFloat(((50 + 0.5 * 10) / 96 * 100).toFixed(1));
      expect(result.effectiveFGPct).toBe(expected);
    });

    it('should return recentStatValues for the focus stat', () => {
      const result = adapter.applyFormulas(mockGameStats, 'points');
      expect(result.recentStatValues).toEqual([30, 25, 28, 32, 22]);
    });

    it('should return correct recentStatValues for rebounds', () => {
      const result = adapter.applyFormulas(mockGameStats, 'rebounds');
      expect(result.recentStatValues).toEqual([8, 9, 7, 10, 6]);
      expect(result.focusStatAvg).toBe(8); // (8+9+7+10+6)/5
    });

    it('should handle empty stats array gracefully', () => {
      const result = adapter.applyFormulas([], 'points');
      expect(result).toEqual({});
    });

    it('should handle null stats gracefully', () => {
      const result = adapter.applyFormulas(null, 'points');
      expect(result).toEqual({});
    });
  });

  // ── calculateConfidence ────────────────────────────────────────────────────

  describe('calculateConfidence()', () => {
    it('should return 80 when player hits OVER in 4 of 5 games', () => {
      const score = adapter.calculateConfidence({
        recentValues: [28, 30, 24, 31, 27], // 25.5 line: 28✓, 30✓, 24✗, 31✓, 27✓ = 4/5
        line: 25.5,
        direction: 'over',
      });
      expect(score).toBe(80);
    });

    it('should return 100 when player always hits the prop', () => {
      const score = adapter.calculateConfidence({
        recentValues: [28, 30, 29, 31, 27],
        line: 25.5,
        direction: 'over',
      });
      expect(score).toBe(100);
    });

    it('should return 0 for empty recent values', () => {
      const score = adapter.calculateConfidence({
        recentValues: [],
        line: 25.5,
        direction: 'over',
      });
      expect(score).toBe(0);
    });

    it('should work correctly for UNDER direction', () => {
      const score = adapter.calculateConfidence({
        recentValues: [20, 22, 21, 24, 23], // All under 25.5
        line: 25.5,
        direction: 'under',
      });
      expect(score).toBe(100);
    });
  });

  // ── calculateEdge ──────────────────────────────────────────────────────────

  describe('calculateEdge()', () => {
    it('should return positive edge when predicted > line (OVER edge)', () => {
      // Predicted 28, line 25.5 → edge = (28-25.5)/25.5 * 100 = 9.8%
      const edge = adapter.calculateEdge(28, 25.5);
      expect(parseFloat(edge)).toBeCloseTo(9.8, 1);
    });

    it('should return negative edge when predicted < line (UNDER edge)', () => {
      // Predicted 22, line 25.5 → edge = (22-25.5)/25.5 * 100 = -13.7%
      const edge = adapter.calculateEdge(22, 25.5);
      expect(parseFloat(edge)).toBeCloseTo(-13.73, 1);
    });

    it('should return 0 when line is 0', () => {
      const edge = adapter.calculateEdge(25, 0);
      expect(parseFloat(edge)).toBe(0);
    });
  });

  // ── normalizeGame ──────────────────────────────────────────────────────────

  describe('normalizeGame()', () => {
    it('should normalize an Odds API game object correctly', () => {
      const rawGame = {
        id: 'abc123',
        home_team: 'Los Angeles Lakers',
        away_team: 'Golden State Warriors',
        commence_time: '2024-01-15T02:00:00Z',
      };

      const normalized = adapter.normalizeGame(rawGame);

      expect(normalized.sport).toBe('nba');
      expect(normalized.league).toBe('NBA');
      expect(normalized.oddsEventId).toBe('abc123');
      expect(normalized.homeTeam.name).toBe('Los Angeles Lakers');
      expect(normalized.homeTeam.abbreviation).toBe('LAL');
      expect(normalized.awayTeam.abbreviation).toBe('GSW');
      expect(normalized.startTime).toBeInstanceOf(Date);
    });
  });

  // ── buildPrompt ────────────────────────────────────────────────────────────

  describe('buildPrompt()', () => {
    it('should include the betting line in the prompt', () => {
      const prompt = adapter.buildPrompt({
        processedStats: {
          avgPoints: 28, avgRebounds: 8, avgAssists: 7, avgThrees: 2, avgMinutes: 35,
          trueShootingPct: 62, effectiveFGPct: 55, approxUSGPct: 30,
          recentStatValues: [28, 30, 25], gamesAnalyzed: 3, focusStatAvg: 27.7,
        },
        playerName: 'LeBron James',
        statType: 'points',
        bettingLine: 25.5,
        marketType: 'player_prop',
      });

      // The betting line MUST be in the prompt (architecture requirement)
      expect(prompt).toContain('25.5');
      expect(prompt).toContain('LeBron James');
      expect(prompt).toContain('OVER');
      expect(prompt).toContain('"recommendation":"over"|"under"');
      expect(prompt).toContain('DATA FLAGS:');
    });

    it('should include advanced metrics in the prompt', () => {
      const prompt = adapter.buildPrompt({
        processedStats: {
          avgPoints: 28, avgRebounds: 8, avgAssists: 7, avgThrees: 2, avgMinutes: 35,
          trueShootingPct: 62, effectiveFGPct: 55, approxUSGPct: 30,
          recentStatValues: [28], gamesAnalyzed: 1, focusStatAvg: 28,
        },
        playerName: 'Test Player',
        statType: 'points',
        bettingLine: 25.5,
        marketType: 'player_prop',
      });

      expect(prompt).toContain('TS%');
      expect(prompt).toContain('eFG%');
      expect(prompt).toContain('USG%');
    });
  });
});
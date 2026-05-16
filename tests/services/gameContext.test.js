const { detectNBAGameContext } = require('../../src/services/shared/gameContext');

describe('gameContext.detectNBAGameContext', () => {
  it('respects explicit provider playoff flag true', () => {
    const result = detectNBAGameContext({
      isPlayoff: true,
      playoffRound: 'Conference Finals',
      startTime: '2026-04-05T00:00:00.000Z',
      eventTitle: 'Random title',
    });

    expect(result.isPlayoff).toBe(true);
    expect(result.round).toBe('Conference Finals');
  });

  it('respects explicit provider playoff flag false even during playoff months', () => {
    const result = detectNBAGameContext({
      isPlayoff: false,
      startTime: '2026-05-20T00:00:00.000Z',
      eventTitle: 'NBA Finals Game 2',
    });

    expect(result.isPlayoff).toBe(false);
    expect(result.round).toBe(null);
  });

  it('does not infer playoffs for early-April games without explicit playoff markers', () => {
    const result = detectNBAGameContext({
      startTime: '2026-04-05T00:00:00.000Z',
      eventTitle: 'New York Knicks vs Boston Celtics',
    });

    expect(result.isPlayoff).toBe(false);
  });

  it('infers playoffs for late-April games as fallback', () => {
    const result = detectNBAGameContext({
      startTime: '2026-04-20T00:00:00.000Z',
      eventTitle: 'New York Knicks vs Boston Celtics',
    });

    expect(result.isPlayoff).toBe(true);
  });
});

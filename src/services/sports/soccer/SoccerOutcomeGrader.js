/**
 * SoccerOutcomeGrader.js — Soccer-specific fixture stat fetch for outcomes
 *
 * Uses API-Football fixture-level player stats so outcome grading can compare
 * an insight against the actual match row (not synthetic season averages).
 */

const ApiSportsClient = require('../../shared/ApiSportsClient');
const logger = require('../../../config/logger');

const MLS_LEAGUE_ID = 253;
const FIXTURE_MATCH_WINDOW_HOURS = 36;

let _client = null;
const client = () => {
  if (!_client) _client = new ApiSportsClient('soccer');
  return _client;
};

const normName = (name = '') => String(name)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[.'\-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const seasonForGame = (game = {}) => {
  const baseDate = game?.startTime ? new Date(game.startTime) : new Date();
  const year = baseDate.getUTCFullYear();
  if (Number(game?.leagueId) === MLS_LEAGUE_ID) return year;
  return (baseDate.getUTCMonth() + 1) >= 8 ? year : year - 1;
};

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const ymd = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

const isNameMatch = (target, candidate) => {
  if (!target || !candidate) return false;
  if (target === candidate) return true;

  const t = target.split(' ');
  const c = candidate.split(' ');
  const tLast = t[t.length - 1] || '';
  const cLast = c[c.length - 1] || '';
  const tFirst = t[0] || '';
  const cFirst = c[0] || '';

  if (tLast && cLast && tLast === cLast && tFirst[0] && cFirst[0] && tFirst[0] === cFirst[0]) {
    return true;
  }

  // Loose fallback for variant spacing/ordering cases
  return (target.includes(candidate) && candidate.length >= 6)
    || (candidate.includes(target) && target.length >= 6);
};

function pickBestFixture(fixtures, game) {
  if (!Array.isArray(fixtures) || !fixtures.length) return null;

  const start = game?.startTime ? new Date(game.startTime) : null;
  const homeId = Number(game?.homeTeam?.apiSportsId) || null;
  const awayId = Number(game?.awayTeam?.apiSportsId) || null;
  const homeName = normName(game?.homeTeam?.name || '');
  const awayName = normName(game?.awayTeam?.name || '');

  let best = null;
  let bestScore = -Infinity;

  for (const row of fixtures) {
    const fixture = row?.fixture || {};
    const teams = row?.teams || {};
    const home = teams?.home || {};
    const away = teams?.away || {};

    const fixtureTs = Number(fixture?.timestamp) ? Number(fixture.timestamp) * 1000 : null;
    const homeTeamId = Number(home?.id) || null;
    const awayTeamId = Number(away?.id) || null;
    const homeTeamName = normName(home?.name || '');
    const awayTeamName = normName(away?.name || '');

    let score = 0;

    if (homeId && awayId && homeTeamId === homeId && awayTeamId === awayId) score += 100;
    if (homeId && awayId && homeTeamId === awayId && awayTeamId === homeId) score += 90;

    if (homeName && awayName && homeTeamName === homeName && awayTeamName === awayName) score += 80;
    if (homeName && awayName && homeTeamName === awayName && awayTeamName === homeName) score += 70;

    if (start && fixtureTs) {
      const diffHours = Math.abs(fixtureTs - start.getTime()) / 3600000;
      if (diffHours <= FIXTURE_MATCH_WINDOW_HOURS) {
        score += Math.max(0, 40 - diffHours);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore > 0 ? best : null;
}

async function resolveFixtureForGame(game, statsCache) {
  const eventId = String(game?.oddsEventId || '');
  if (!eventId) return null;

  const fixtureCacheKey = `soccer:fixture:${eventId}`;
  if (statsCache.has(fixtureCacheKey)) return statsCache.get(fixtureCacheKey);

  const leagueId = Number(game?.leagueId) || null;
  if (!leagueId) {
    statsCache.set(fixtureCacheKey, null);
    return null;
  }

  const season = seasonForGame(game);
  const gameDate = game?.startTime ? new Date(game.startTime) : new Date();
  const from = ymd(new Date(gameDate.getTime() - 2 * 24 * 3600000));
  const to = ymd(new Date(gameDate.getTime() + 2 * 24 * 3600000));

  try {
    const fixtures = await client().get('fixtures', { league: leagueId, season, from, to }) || [];
    const best = pickBestFixture(fixtures, game);
    const resolved = best
      ? {
          fixtureId: Number(best?.fixture?.id) || null,
          fixtureDate: best?.fixture?.date || null,
        }
      : null;

    statsCache.set(fixtureCacheKey, resolved);
    return resolved;
  } catch (err) {
    logger.warn('[SoccerOutcomeGrader] resolve fixture failed', {
      eventId,
      leagueId,
      error: err.message,
    });
    statsCache.set(fixtureCacheKey, null);
    return null;
  }
}

async function fetchFixturePlayers(fixtureId, fixtureDate, statsCache) {
  if (!fixtureId) return [];

  const key = `soccer:fixture:players:${fixtureId}`;
  if (statsCache.has(key)) return statsCache.get(key);

  try {
    const groups = await client().get('fixtures/players', { fixture: fixtureId }) || [];
    const rows = [];

    for (const g of groups) {
      const teamId = Number(g?.team?.id) || null;
      for (const p of g?.players || []) {
        const s = Array.isArray(p?.statistics) ? (p.statistics[0] || {}) : {};
        const playerName = p?.player?.name || '';
        if (!playerName) continue;

        rows.push({
          fixtureId,
          date: fixtureDate || null,
          gameDate: fixtureDate || null,
          playerId: Number(p?.player?.id) || null,
          playerName,
          _normName: normName(playerName),
          teamId,
          goals: toNum(s?.goals?.total),
          assists: toNum(s?.goals?.assists),
          shots_on_target: toNum(s?.shots?.on),
          minutes: toNum(s?.games?.minutes),
        });
      }
    }

    statsCache.set(key, rows);
    return rows;
  } catch (err) {
    logger.warn('[SoccerOutcomeGrader] fixture player stats failed', {
      fixtureId,
      error: err.message,
    });
    statsCache.set(key, []);
    return [];
  }
}

async function fetchStatsForInsight(insight, game, statsCache) {
  if (!game) return [];

  const playerNameNorm = normName(insight?.playerName || '');
  if (!playerNameNorm) return [];

  const perInsightKey = `soccer:insight:${insight?.eventId}:${playerNameNorm}`;
  if (statsCache.has(perInsightKey)) return statsCache.get(perInsightKey);

  const fixture = await resolveFixtureForGame(game, statsCache);
  if (!fixture?.fixtureId) {
    statsCache.set(perInsightKey, []);
    return [];
  }

  const rows = await fetchFixturePlayers(fixture.fixtureId, fixture.fixtureDate, statsCache);
  if (!rows.length) {
    statsCache.set(perInsightKey, []);
    return [];
  }

  const exact = rows.find((r) => r._normName === playerNameNorm);
  if (exact) {
    const out = [{ ...exact }];
    statsCache.set(perInsightKey, out);
    return out;
  }

  const loose = rows.find((r) => isNameMatch(playerNameNorm, r._normName));
  if (loose) {
    const out = [{ ...loose }];
    statsCache.set(perInsightKey, out);
    return out;
  }

  statsCache.set(perInsightKey, []);
  return [];
}

module.exports = { fetchStatsForInsight };

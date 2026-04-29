require('dotenv').config();

const axios = require('axios');
const connectDB = require('../src/config/database');
const { Game } = require('../src/models/Game.model');
const PlayerProp = require('../src/models/PlayerProp.model');
const { PlayerCache } = require('../src/utils/playerResolver');
const { getAdapter } = require('../src/services/adapters/adapterRegistry');

const BASES = [
  'https://statpal.io/api/v1',
  'https://statpal.io/api/v2',
];

function parseArgs(argv) {
  const out = {
    sport: 'nba',
    player: null,
    limit: 10,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sport' && argv[i + 1]) out.sport = String(argv[++i]).toLowerCase();
    else if (arg === '--player' && argv[i + 1]) out.player = argv[++i];
    else if (arg === '--limit' && argv[i + 1]) out.limit = Math.max(1, parseInt(argv[++i], 10) || 10);
  }

  return out;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\'.]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNameMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const aLast = na.split(' ').pop();
  const bLast = nb.split(' ').pop();
  return aLast === bLast;
}

function pickTeamNameFromGame(game, playerName) {
  if (!game) return null;
  const homeName = game.homeTeam?.name || null;
  const awayName = game.awayTeam?.name || null;

  const starterHome = game.startingPitchers?.home?.name;
  const starterAway = game.startingPitchers?.away?.name;
  if (isNameMatch(starterHome, playerName)) return homeName;
  if (isNameMatch(starterAway, playerName)) return awayName;

  return homeName || awayName || null;
}

async function discoverTargets({ sport, player, limit }) {
  if (player) {
    return [{ playerName: player, teamNameHint: null, source: 'arg' }];
  }

  const rows = await PlayerProp.find({ sport, isAvailable: true })
    .sort({ updatedAt: -1 })
    .limit(limit * 6)
    .select('playerName gameId')
    .lean();

  const uniqueByPlayer = new Map();
  for (const row of rows) {
    if (uniqueByPlayer.size >= limit) break;
    if (!row.playerName || uniqueByPlayer.has(row.playerName)) continue;

    const game = row.gameId ? await Game.findById(row.gameId).select('homeTeam awayTeam startingPitchers').lean() : null;
    uniqueByPlayer.set(row.playerName, {
      playerName: row.playerName,
      teamNameHint: pickTeamNameFromGame(game, row.playerName),
      source: 'recent-props',
    });
  }

  return [...uniqueByPlayer.values()];
}

async function rosterCandidateId({ sport, playerName, teamNameHint }) {
  if (!teamNameHint) return null;
  try {
    const adapter = getAdapter(sport);
    const roster = await adapter.fetchRoster(teamNameHint);
    const found = (roster?.players || []).find((p) => isNameMatch(p.name, playerName));
    return found?.statpalId ? String(found.statpalId) : null;
  } catch {
    return null;
  }
}

async function resolveTeamHintFromRecentRosters({ sport, playerName }) {
  const adapter = getAdapter(sport);
  const recentGames = await Game.find({
    sport,
    startTime: { $gte: new Date(Date.now() - (72 * 60 * 60 * 1000)) },
  })
    .sort({ startTime: -1 })
    .limit(40)
    .select('homeTeam awayTeam')
    .lean();

  const teamNames = [...new Set(
    recentGames
      .flatMap((g) => [g.homeTeam?.name, g.awayTeam?.name])
      .filter(Boolean)
  )];

  for (const teamName of teamNames) {
    try {
      const roster = await adapter.fetchRoster(teamName);
      const match = (roster?.players || []).find((p) => isNameMatch(p.name, playerName));
      if (match) return teamName;
    } catch {
      // Keep scanning other teams even if one roster endpoint is temporarily unavailable.
      continue;
    }
  }

  return null;
}

async function cacheCandidateId({ sport, playerName }) {
  const cached = await PlayerCache.findOne({
    sport,
    sourcePlayerName: normalizeName(playerName),
    statpalPlayerId: { $ne: null },
  }).lean();
  return cached?.statpalPlayerId ? String(cached.statpalPlayerId) : null;
}

async function propCandidateIds({ sport, playerName }) {
  const ids = await PlayerProp.distinct('statpalPlayerId', {
    sport,
    playerName,
    statpalPlayerId: { $ne: null },
  });
  return ids.map((v) => String(v)).filter(Boolean);
}

function extractLogsCount(payload) {
  const candidates = [
    payload?.results,
    payload?.logs,
    payload?.data?.results,
    payload?.data?.logs,
  ];
  for (const arr of candidates) {
    if (Array.isArray(arr)) return arr.length;
  }
  return 0;
}

function extractWindowHints(payload) {
  const ctx = payload?.stats_context || payload?.splits || payload?.stats || payload?.data?.stats_context || null;
  if (!ctx || typeof ctx !== 'object') return [];
  return Object.keys(ctx).slice(0, 8);
}

async function probeEndpoint(url, params) {
  const start = Date.now();
  try {
    const res = await axios.get(url, { params, timeout: 12000 });
    return {
      ok: true,
      status: res.status,
      latencyMs: Date.now() - start,
      payload: res.data,
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || null,
      latencyMs: Date.now() - start,
      error: err.response?.data?.error || err.message,
      payload: err.response?.data || null,
    };
  }
}

async function probeCandidate({ sport, playerName, candidateId }) {
  const checks = [];

  for (const base of BASES) {
    const logsUrl = `${base}/${sport}/players/${candidateId}/game-logs`;
    const statsUrl = `${base}/${sport}/players/${candidateId}/stats`;

    const [logsRes, statsRes] = await Promise.all([
      probeEndpoint(logsUrl, { access_key: process.env.STATPAL_ACCESS_KEY, last: 10 }),
      probeEndpoint(statsUrl, { access_key: process.env.STATPAL_ACCESS_KEY, last: 10 }),
    ]);

    checks.push({
      base,
      logs: {
        status: logsRes.status,
        ok: logsRes.ok,
        latencyMs: logsRes.latencyMs,
        count: extractLogsCount(logsRes.payload),
        error: logsRes.ok ? null : logsRes.error,
      },
      stats: {
        status: statsRes.status,
        ok: statsRes.ok,
        latencyMs: statsRes.latencyMs,
        windowHints: extractWindowHints(statsRes.payload),
        error: statsRes.ok ? null : statsRes.error,
      },
    });
  }

  const best = checks.find((c) => c.logs.ok && c.logs.count > 0) || null;
  const any200 = checks.some((c) => c.logs.ok || c.stats.ok);

  return {
    playerName,
    candidateId,
    unlocksLogs: Boolean(best),
    bestBase: best?.base || null,
    any200,
    checks,
  };
}

async function diagnoseOnePlayer({ sport, playerName, teamNameHint }) {
  let resolvedTeamHint = teamNameHint;
  if (!resolvedTeamHint) {
    resolvedTeamHint = await resolveTeamHintFromRecentRosters({ sport, playerName });
  }

  const [cacheId, rosterId, propIds] = await Promise.all([
    cacheCandidateId({ sport, playerName }),
    rosterCandidateId({ sport, playerName, teamNameHint: resolvedTeamHint }),
    propCandidateIds({ sport, playerName }),
  ]);

  const dedupIds = [...new Set([cacheId, rosterId, ...propIds].filter(Boolean))];
  if (dedupIds.length === 0) {
    return {
      playerName,
      teamNameHint: resolvedTeamHint,
      candidateIds: [],
      winner: null,
      probes: [],
      note: 'No candidate ID found from cache/roster/props.',
    };
  }

  const probes = [];
  for (const candidateId of dedupIds) {
    probes.push(await probeCandidate({ sport, playerName, candidateId }));
  }

  const winner = probes.find((p) => p.unlocksLogs) || null;
  return {
    playerName,
    teamNameHint: resolvedTeamHint,
    candidateIds: dedupIds,
    winner: winner ? { candidateId: winner.candidateId, base: winner.bestBase } : null,
    probes,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  await connectDB();

  const targets = await discoverTargets(opts);
  const results = [];

  for (const target of targets) {
    results.push(await diagnoseOnePlayer({
      sport: opts.sport,
      playerName: target.playerName,
      teamNameHint: target.teamNameHint,
    }));
  }

  const unlockable = results.filter((r) => r.winner).length;
  const summary = {
    sport: opts.sport,
    testedPlayers: results.length,
    unlockable,
    blocked: results.length - unlockable,
    ranAt: new Date().toISOString(),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(unlockable > 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

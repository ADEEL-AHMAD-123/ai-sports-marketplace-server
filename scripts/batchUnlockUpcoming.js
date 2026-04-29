require('dotenv').config();

const connectDB = require('../src/config/database');
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const { Game, GAME_STATUS } = require('../src/models/Game.model');
const PlayerProp = require('../src/models/PlayerProp.model');
const InsightService = require('../src/services/InsightService');
const logger = require('../src/config/logger');

// Reduce noisy logs so long runs don't choke terminal output.
logger.info = () => {};
logger.debug = () => {};
logger.warn = () => {};

const TARGET_PER_SPORT = 40;
const SPORTS = ['nba', 'mlb'];

async function pickUser() {
  // Prefer active user with highest credits (user mentioned credits already added).
  const user = await User.findOne({ isActive: true })
    .sort({ credits: -1, updatedAt: -1 })
    .exec();

  if (!user) throw new Error('No active user found to unlock insights for.');
  return user;
}

async function upcomingGames(sport) {
  const now = new Date();
  return Game.find({
    sport,
    startTime: { $gte: now },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  })
    .sort({ startTime: 1 })
    .limit(2)
    .select('_id oddsEventId startTime homeTeam awayTeam sport')
    .lean();
}

async function propsForGame(sport, oddsEventId) {
  return PlayerProp.find({
    sport,
    oddsEventId,
    isAvailable: true,
  })
    .sort({ confidenceScore: -1, edgePercentage: -1, lastUpdatedAt: -1 })
    .select('sport oddsEventId playerName statType line apiSportsPlayerId')
    .lean();
}

async function unlockOneProp(prop, userId) {
  const user = await User.findById(userId);
  if (!user) return { ok: false, reason: 'user_missing' };
  if (!user.hasEnoughCredits || !user.hasEnoughCredits(1)) {
    return { ok: false, reason: 'insufficient_credits' };
  }

  try {
    const result = await InsightService.generateInsight({
      sport: prop.sport,
      eventId: prop.oddsEventId,
      playerName: prop.playerName,
      statType: prop.statType,
      bettingLine: prop.line,
      marketType: 'player_prop',
      user,
      apiSportsPlayerId: prop.apiSportsPlayerId || null,
    });

    if (result?.insight) {
      return {
        ok: true,
        creditDeducted: Boolean(result.creditDeducted),
        insightId: String(result.insight._id || ''),
      };
    }

    return { ok: false, reason: result?.reason || result?.error || 'no_insight' };
  } catch (err) {
    return { ok: false, reason: err.message || 'unlock_failed' };
  }
}

async function runSport(sport, userId) {
  const games = await upcomingGames(sport);
  const eventIds = games.map((g) => g.oddsEventId).filter(Boolean);

  const allProps = [];
  for (const id of eventIds) {
    const props = await propsForGame(sport, id);
    allProps.push(...props);
  }

  // Unique by event+player+stat to avoid duplicate unlock attempts.
  const unique = [];
  const seen = new Set();
  for (const p of allProps) {
    const key = `${p.oddsEventId}::${p.playerName}::${p.statType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  let unlocked = 0;
  let charged = 0;
  const failures = [];

  for (const p of unique) {
    if (unlocked >= TARGET_PER_SPORT) break;

    const out = await unlockOneProp(p, userId);
    if (out.ok) {
      unlocked += 1;
      if (out.creditDeducted) charged += 1;
    } else {
      failures.push({
        eventId: p.oddsEventId,
        playerName: p.playerName,
        statType: p.statType,
        reason: out.reason,
      });
      if (out.reason === 'insufficient_credits') break;
    }
  }

  return {
    sport,
    target: TARGET_PER_SPORT,
    unlocked,
    charged,
    gamesConsidered: games.map((g) => ({
      eventId: g.oddsEventId,
      startTime: g.startTime,
      matchup: `${g.awayTeam?.name || '?'} @ ${g.homeTeam?.name || '?'}`,
    })),
    propsScanned: unique.length,
    failures: failures.slice(0, 20),
  };
}

async function main() {
  await connectDB();

  const user = await pickUser();
  const before = user.credits;

  const perSport = [];
  for (const sport of SPORTS) {
    perSport.push(await runSport(sport, user._id));
  }

  const refreshedUser = await User.findById(user._id).lean();
  const after = refreshedUser?.credits ?? null;

  const summary = {
    user: {
      id: String(user._id),
      email: user.email || null,
      beforeCredits: before,
      afterCredits: after,
      spentCredits: (typeof before === 'number' && typeof after === 'number') ? before - after : null,
    },
    requested: { nba: TARGET_PER_SPORT, mlb: TARGET_PER_SPORT },
    results: perSport,
    totalUnlocked: perSport.reduce((s, x) => s + x.unlocked, 0),
    totalCharged: perSport.reduce((s, x) => s + x.charged, 0),
    completedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(summary, null, 2));
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});

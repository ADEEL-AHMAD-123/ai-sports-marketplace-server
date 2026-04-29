require('dotenv').config();

const connectDB = require('../src/config/database');
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const Insight = require('../src/models/Insight.model');
const PlayerProp = require('../src/models/PlayerProp.model');
const { Game, GAME_STATUS } = require('../src/models/Game.model');
const InsightService = require('../src/services/InsightService');
const logger = require('../src/config/logger');

logger.info = () => {};
logger.warn = () => {};
logger.debug = () => {};

const TARGET_PER_SPORT = 40;
const SPORTS = ['nba', 'mlb'];

async function getTargetUser() {
  const users = await User.find({ isActive: true }).sort({ credits: -1, updatedAt: -1 }).limit(20);
  if (!users.length) return null;
  const nonAdminEnough = users.find((u) => (u.role === 'user' || !u.role) && u.credits >= 1);
  const nonAdmin = users.find((u) => (u.role === 'user' || !u.role));
  return nonAdminEnough || nonAdmin || users[0];
}

async function getFirstTwoUpcomingGamesBySport(sport) {
  const now = new Date();
  return Game.find({
    sport,
    startTime: { $gte: now },
    status: { $in: [GAME_STATUS.SCHEDULED, GAME_STATUS.LIVE] },
  }).sort({ startTime: 1 }).limit(2).lean();
}

async function getCandidateProps(sport, eventIds) {
  const props = await PlayerProp.find({
    sport,
    oddsEventId: { $in: eventIds },
    isAvailable: true,
    line: { $ne: null },
  })
    .select('sport oddsEventId playerName statType line lastUpdatedAt confidenceScore edgePercentage')
    .sort({ lastUpdatedAt: -1, confidenceScore: -1, edgePercentage: -1 })
    .lean();

  const seen = new Set();
  const deduped = [];
  for (const p of props) {
    const key = `${p.sport}::${p.oddsEventId}::${p.playerName}::${p.statType}::${p.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  return deduped;
}

async function resolveExistingInsightForProp(p) {
  return Insight.findExisting({
    sport: p.sport,
    eventId: p.oddsEventId,
    playerName: p.playerName,
    statType: p.statType,
    bettingLine: p.line,
  });
}

async function unlockForSport(userId, sport) {
  const games = await getFirstTwoUpcomingGamesBySport(sport);
  const eventIds = games.map((g) => g.oddsEventId).filter(Boolean);
  if (!eventIds.length) {
    return {
      sport,
      games: [],
      eventIds: [],
      candidateProps: 0,
      unlockedTarget: 0,
      alreadyUnlocked: 0,
      attachedExisting: 0,
      generated: 0,
      deducted: 0,
      preflightOrUnavailable: 0,
      errors: [],
    };
  }

  const candidates = await getCandidateProps(sport, eventIds);
  let user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  let unlockedTarget = 0;
  let alreadyUnlocked = 0;
  let attachedExisting = 0;
  let generated = 0;
  let deducted = 0;
  let preflightOrUnavailable = 0;
  const errors = [];

  for (const p of candidates) {
    if (unlockedTarget >= TARGET_PER_SPORT) break;

    try {
      const existing = await resolveExistingInsightForProp(p);

      if (existing && user.hasUnlockedInsight(existing._id)) {
        unlockedTarget += 1;
        alreadyUnlocked += 1;
        continue;
      }

      if (existing && !user.hasUnlockedInsight(existing._id)) {
        await User.findByIdAndUpdate(userId, { $addToSet: { unlockedInsights: existing._id } });
        user = await User.findById(userId);
        unlockedTarget += 1;
        attachedExisting += 1;
        continue;
      }

      if (user.credits <= 0) {
        errors.push('Credits exhausted before reaching target');
        break;
      }

      const result = await InsightService.generateInsight({
        sport: p.sport,
        eventId: p.oddsEventId,
        playerName: p.playerName,
        statType: p.statType,
        bettingLine: Number(p.line),
        marketType: 'player_prop',
        user,
      });

      if (result && result.insight) {
        user = await User.findById(userId);
        unlockedTarget += 1;
        generated += 1;
        if (result.creditDeducted) deducted += 1;
      } else {
        preflightOrUnavailable += 1;
      }
    } catch (err) {
      errors.push(`${p.playerName} ${p.statType} ${p.line}: ${err.message}`);
      if (errors.length > 50) break;
    }
  }

  return {
    sport,
    games: games.map((g) => ({
      eventId: g.oddsEventId,
      startTime: g.startTime,
      matchup: `${g.awayTeam?.name || '?'} @ ${g.homeTeam?.name || '?'}`,
    })),
    eventIds,
    candidateProps: candidates.length,
    unlockedTarget,
    alreadyUnlocked,
    attachedExisting,
    generated,
    deducted,
    preflightOrUnavailable,
    errors: errors.slice(0, 25),
  };
}

(async () => {
  try {
    await connectDB();

    const user = await getTargetUser();
    if (!user) {
      console.log(JSON.stringify({ ok: false, reason: 'No active user found' }, null, 2));
      process.exit(1);
      return;
    }

    const startCredits = user.credits;
    const results = [];
    for (const sport of SPORTS) {
      results.push(await unlockForSport(user._id, sport));
    }

    const refreshedUser = await User.findById(user._id).lean();

    const summary = {
      ok: true,
      selectedUser: {
        id: String(user._id),
        email: user.email,
        role: user.role,
      },
      startCredits,
      endCredits: refreshedUser ? refreshedUser.credits : null,
      creditsSpent:
        refreshedUser && typeof refreshedUser.credits === 'number'
          ? startCredits - refreshedUser.credits
          : null,
      targets: { nba: TARGET_PER_SPORT, mlb: TARGET_PER_SPORT },
      results,
      totals: {
        unlockedTowardTargets: results.reduce((s, r) => s + (r.unlockedTarget || 0), 0),
        generated: results.reduce((s, r) => s + (r.generated || 0), 0),
        deducted: results.reduce((s, r) => s + (r.deducted || 0), 0),
      },
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('BULK_UNLOCK_ERR', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.connection.close();
    } catch (e) {
      // ignore
    }
  }
})();

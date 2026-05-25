/**
 * outcomeCoverage.job.js — Performance-data coverage
 *
 * Guarantees a representative, graded-able set of insights for accuracy stats
 * and the public proof feeds (scout-closings, hero) even when real users are
 * quiet.
 *
 * Each run finds games at "final lock" (kickoff inside the lock window) and,
 * per sport per stat type, tops up the day's insight count to a target by
 * auto-generating SYSTEM insights for the strongest still-available props.
 * postGameSync grades these exactly like user insights once the game finals.
 *
 * COST CONTROLS
 *  • Only the daily shortfall is generated — user unlocks count toward the
 *    target, so spend shrinks as real usage grows.
 *  • Each game is covered exactly once (Game.coverageDoneAt).
 *  • A hard global daily cap (COVERAGE_DAILY_MAX) bounds OpenAI spend.
 *  • Props already carrying a generated insight are skipped (no duplicates).
 *
 * TO RUN STANDALONE:
 *   node -e "require('./src/jobs/outcomeCoverage.job').runOutcomeCoverage().then(r=>console.log(r))"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const cron   = require('node-cron');
const { Game, GAME_STATUS } = require('../models/Game.model');
const Insight        = require('../models/Insight.model');
const PlayerProp     = require('../models/PlayerProp.model');
const InsightService = require('../services/InsightService');
const logger         = require('../config/logger');

const envInt = (key, fallback) => {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
};

const SCHEDULE = (process.env.CRON_OUTCOME_COVERAGE_SCHEDULE || '*/15 * * * *').trim();

// Lock window — generate once a game's kickoff is between MIN and MAX minutes
// away. MAX is set wider than the answer's "60m" so a skipped cron cycle still
// catches the game before kickoff.
const LOCK_MIN_MINUTES = Math.max(0,  envInt('COVERAGE_LOCK_MIN_MINUTES', 30));
const LOCK_MAX_MINUTES = Math.max(LOCK_MIN_MINUTES + 5, envInt('COVERAGE_LOCK_MAX_MINUTES', 75));

// Per (sport, stat type) daily target and the hard global daily cap.
const PER_TYPE_DAILY_TARGET = Math.max(1, envInt('COVERAGE_PER_TYPE_DAILY_TARGET', 3));
const DAILY_MAX             = Math.max(1, envInt('COVERAGE_DAILY_MAX', 120));

// The stat types each sport's coverage spans — matches the adapter market maps
// and the InsightOutcomeService extractStat keys.
const SPORT_STAT_TYPES = {
  nba:    ['points', 'rebounds', 'assists', 'threes', 'points_assists'],
  mlb:    ['hits', 'total_bases', 'pitcher_strikeouts', 'rbis', 'runs'],
  nhl:    ['shots_on_goal', 'goals', 'assists', 'points'],
  nfl:    ['passing_yards', 'rushing_yards', 'receiving_yards', 'receptions', 'pass_tds', 'rush_reception_yards'],
  soccer: ['goals', 'assists', 'shots_on_target'],
};

let coverageRunning = false;

const _startOfUtcDay = (now) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * One coverage pass. Safe to call directly (standalone / tests).
 */
async function runOutcomeCoverage(now = new Date()) {
  logger.info('🎯 [OutcomeCoverage] Starting...');

  const dayStart = _startOfUtcDay(now);

  // ── Global daily cap — count today's system-generated insights ───────────
  let systemToday = await Insight.countDocuments({
    generatedBy: 'system',
    createdAt:   { $gte: dayStart },
  });
  if (systemToday >= DAILY_MAX) {
    logger.info(`[OutcomeCoverage] Daily cap reached (${systemToday}/${DAILY_MAX}) — skipping`);
    return { generated: 0, skipped: 0, capped: true };
  }

  // ── Games at final lock, not yet covered ─────────────────────────────────
  const lockStart = new Date(now.getTime() + LOCK_MIN_MINUTES * 60000);
  const lockEnd   = new Date(now.getTime() + LOCK_MAX_MINUTES * 60000);
  const games = await Game.find({
    status:         GAME_STATUS.SCHEDULED,
    startTime:      { $gte: lockStart, $lte: lockEnd },
    coverageDoneAt: { $in: [null, undefined] },
  }).select('_id sport oddsEventId startTime').lean();

  if (!games.length) {
    logger.info('[OutcomeCoverage] No games at final lock');
    return { generated: 0, skipped: 0 };
  }

  // ── Today's existing insight counts per (sport, statType) — user+system ──
  const countsAgg = await Insight.aggregate([
    { $match: { status: 'generated', createdAt: { $gte: dayStart } } },
    { $group: { _id: { sport: '$sport', statType: '$statType' }, n: { $sum: 1 } } },
  ]);
  const countByKey = new Map(); // `${sport}::${statType}` -> count
  for (const r of countsAgg) {
    countByKey.set(`${r._id.sport}::${r._id.statType}`, r.n);
  }

  let generated = 0;
  let skipped   = 0;

  for (const game of games) {
    const statTypes = SPORT_STAT_TYPES[game.sport] || [];
    if (!statTypes.length) {
      await Game.updateOne({ _id: game._id }, { $set: { coverageDoneAt: now } });
      continue;
    }

    // Available, lined props for this game — best (most confident) first.
    const props = await PlayerProp.find({
      sport:       game.sport,
      oddsEventId: game.oddsEventId,
      isAvailable: true,
      line:        { $ne: null },
    })
      .sort({ confidenceScore: -1 })
      .select('playerName statType line marketType apiSportsPlayerId injuryStatus')
      .lean();

    // Props that already carry a generated insight — skip them (no duplicates).
    const existing = await Insight.find({
      eventId: game.oddsEventId,
      status:  'generated',
    }).select('playerName statType bettingLine').lean();
    const coveredProps = new Set(
      existing.map((i) => `${i.playerName}::${i.statType}::${i.bettingLine}`)
    );

    // Group still-uncovered props by stat type, skipping ruled-out players.
    const propsByType = new Map();
    for (const p of props) {
      if (p.injuryStatus === 'Out') continue;
      if (coveredProps.has(`${p.playerName}::${p.statType}::${p.line}`)) continue;
      if (!propsByType.has(p.statType)) propsByType.set(p.statType, []);
      propsByType.get(p.statType).push(p);
    }

    for (const statType of statTypes) {
      if (systemToday >= DAILY_MAX) break;

      const key  = `${game.sport}::${statType}`;
      const have = countByKey.get(key) || 0;
      if (have >= PER_TYPE_DAILY_TARGET) continue; // day's target already met

      const candidates = propsByType.get(statType) || [];
      if (!candidates.length) continue;            // no uncovered prop of this type

      const pick = candidates[0]; // best-confidence uncovered prop of this type

      try {
        const result = await InsightService.generateInsight({
          sport:             game.sport,
          eventId:           game.oddsEventId,
          playerName:        pick.playerName,
          statType:          pick.statType,
          bettingLine:       pick.line,
          marketType:        pick.marketType || 'player_prop',
          apiSportsPlayerId: pick.apiSportsPlayerId || null,
          generatedBy:       'system',
        });

        if (result?.insight && result.cached === false) {
          generated  += 1;
          systemToday += 1;
          countByKey.set(key, have + 1);
        } else {
          // preflight fail / injury skip / AI failure, or an unexpected cache
          // hit — non-fatal, just no new coverage for this slot.
          skipped += 1;
        }
      } catch (err) {
        skipped += 1;
        logger.warn('[OutcomeCoverage] generation failed', {
          sport: game.sport, eventId: game.oddsEventId, statType, error: err.message,
        });
      }
    }

    // Cover each game exactly once — even if it produced nothing this pass.
    await Game.updateOne({ _id: game._id }, { $set: { coverageDoneAt: now } });
  }

  logger.info(`✅ [OutcomeCoverage] Done — generated ${generated}, skipped ${skipped}, systemToday ${systemToday}`);
  return { generated, skipped, systemToday, gamesProcessed: games.length };
}

const runWithLock = async () => {
  if (coverageRunning) {
    logger.warn('⏭️  [OutcomeCoverage] Previous run still active — skipping');
    return { skipped: true };
  }
  coverageRunning = true;
  try {
    return await runOutcomeCoverage();
  } finally {
    coverageRunning = false;
  }
};

const registerOutcomeCoverageJob = () => {
  const enabled = String(process.env.CRON_OUTCOME_COVERAGE_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) {
    logger.info('⏭️  [OutcomeCoverage] Disabled via env');
    return;
  }
  if (!cron.validate(SCHEDULE)) {
    logger.error('❌ [OutcomeCoverage] Invalid CRON_OUTCOME_COVERAGE_SCHEDULE', { schedule: SCHEDULE });
    return;
  }
  cron.schedule(SCHEDULE, async () => {
    try { await runWithLock(); }
    catch (err) { logger.error('❌ [OutcomeCoverage] Cron crashed', { error: err.message }); }
  });
  logger.info('✅ [OutcomeCoverage] Cron registered', {
    schedule: SCHEDULE,
    lockWindowMinutes: `${LOCK_MIN_MINUTES}-${LOCK_MAX_MINUTES}`,
    perTypeDailyTarget: PER_TYPE_DAILY_TARGET,
    dailyMax: DAILY_MAX,
  });
};

module.exports = { registerOutcomeCoverageJob, runOutcomeCoverage };

if (require.main === module) {
  const connectDB = require('../config/database');
  connectDB()
    .then(() => runOutcomeCoverage())
    .then((r) => { logger.info('Done', r); process.exit(0); })
    .catch((err) => { logger.error('Fatal', { error: err.message }); process.exit(1); });
}

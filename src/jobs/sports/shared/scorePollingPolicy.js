/**
 * scorePollingPolicy.js
 *
 * Central policy for deciding WHETHER to spend an Odds-API /scores credit
 * this postGameSync cycle — the scores-job counterpart to propPollingPolicy.
 *
 * postGameSync runs every ~20m, but a /scores call is only useful when a
 * sport actually has a started game that could be finishing. Game status
 * transitions (SCHEDULED→LIVE, the 3.5h time-based LIVE→FINAL) need no API
 * call at all; /scores is purely the provider-confirmed refinement.
 *
 * Tiered by how far past kickoff a started game is — same shape as the prop
 * policy (frequent near the relevant moment, sparse away from it):
 *
 *   not started ............... no /scores call
 *   0 .. 150m after start ..... "live"   — every 90m  (won't be final yet)
 *   150m .. 360m after start .. "settle" — every 25m  (likely finishing now)
 *   > 360m after start ........ no /scores call (time-based finalize covers it)
 *
 * All thresholds/intervals are env-overridable.
 */

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const POLICY = {
  // A started game enters the "settle" (likely-finishing) band this long
  // after kickoff...
  settleFromMinutes:      toInt(process.env.SCORE_POLL_SETTLE_FROM_MINUTES, 150),
  // ...and leaves it here (after which the time-based finalize handles it).
  settleToMinutes:        toInt(process.env.SCORE_POLL_SETTLE_TO_MINUTES, 360),

  // Poll cadence while a game is settling — tight, to catch the final promptly.
  settleIntervalMinutes:  toInt(process.env.SCORE_POLL_SETTLE_INTERVAL_MINUTES, 25),
  // Poll cadence while games are merely in progress (not yet finishable).
  liveIntervalMinutes:    toInt(process.env.SCORE_POLL_LIVE_INTERVAL_MINUTES, 90),
};

const minutesSince = (date, now) => {
  if (!date) return Infinity;
  const ts = new Date(date).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return (now.getTime() - ts) / 60000;
};

/**
 * Tightest /scores cadence the given started games warrant this cycle.
 *
 * @returns {number|null} minutes between /scores calls, or null when no call
 *          is needed (no started game in a finishable band).
 */
function scorePollIntervalForGames(games, now = new Date()) {
  let need = null; // null | 'live' | 'settle'

  for (const g of games || []) {
    const startTs = new Date(g?.startTime).getTime();
    if (!Number.isFinite(startTs)) continue;

    const minsSinceStart = (now.getTime() - startTs) / 60000;
    if (minsSinceStart < 0) continue;                       // not started
    if (minsSinceStart > POLICY.settleToMinutes) continue;  // long over

    if (minsSinceStart >= POLICY.settleFromMinutes) {
      return POLICY.settleIntervalMinutes;                  // tightest tier — done
    }
    need = 'live';
  }

  if (need === 'live') return POLICY.liveIntervalMinutes;
  return null;
}

/**
 * Should postGameSync spend a /scores call for this sport right now?
 *
 * @param {Array}  games         started/live games for the sport
 * @param {Date}   now
 * @param {Date}   lastFetchedAt last successful /scores call for this sport
 */
function shouldFetchScores(games, now = new Date(), lastFetchedAt = null) {
  const interval = scorePollIntervalForGames(games, now);
  if (interval == null) return false;
  if (!lastFetchedAt) return true;
  return minutesSince(lastFetchedAt, now) >= interval;
}

module.exports = { shouldFetchScores, scorePollIntervalForGames };

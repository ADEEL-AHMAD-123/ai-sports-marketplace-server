/**
 * propPollingPolicy.js
 *
 * Central policy for deciding WHETHER and HOW OFTEN to refresh a game's props.
 *
 * Two distinct windows:
 *   • TRACK window  (48h) — games this far out are loaded/known by the watcher
 *     so they appear in the system, but their props are NOT fetched yet.
 *   • REFRESH window (30h) — once a scheduled game crosses into this window the
 *     watcher starts spending Odds-API credits on it.
 *
 * Cadence — frequent near kickoff and during the game, sparse far out:
 *
 *     12h .. 30h to start   "far"   — every 6h
 *      6h .. 12h to start   "mid"   — every 3h
 *      1h .. 6h  to start   "near"  — every 60m
 *   final 1h before start   "hot"   — every 10m
 *   game in progress (LIVE) "live"  — every 10m   (driven by game.status)
 *
 * The "live" tier is keyed off the game's actual status, not a guessed time
 * window — a game is polled every cycle for as long as it is genuinely LIVE,
 * and stops the moment postGameSync flips it to FINAL.
 *
 * ENGAGEMENT — the fast 10-minute hot/live cadence is reserved for "engaged"
 * games (those with unlocked insights or recent views; see propEngagement).
 * "Cold" games (nobody is looking at them) skip the far tier entirely and get
 * a much sparser hot/live cadence, so the expensive credits are only spent
 * where they matter.
 *
 * Every threshold/interval is env-overridable so the cadence (and the monthly
 * Odds-API spend) can be tuned without a code change.
 */

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const POLICY = {
  // Games are loaded/tracked this far ahead (they exist in the system)...
  trackWindowHours: toInt(process.env.PROP_WATCHER_TRACK_WINDOW_HOURS, 48),
  // ...but a scheduled game's props are only refreshed once within this window.
  refreshWindowHours: toInt(process.env.PROP_WATCHER_REFRESH_WINDOW_HOURS, 30),

  // "far" tier — from this many hours out up to the refresh window edge.
  farTierFromHours:    toInt(process.env.PROP_WATCHER_FAR_TIER_FROM_HOURS, 12),
  farIntervalMinutes:  toInt(process.env.PROP_WATCHER_FAR_INTERVAL_MINUTES, 360),

  // "mid" tier — from this many hours out up to the far tier.
  midTierFromHours:    toInt(process.env.PROP_WATCHER_MID_TIER_FROM_HOURS, 6),
  midIntervalMinutes:  toInt(process.env.PROP_WATCHER_MID_INTERVAL_MINUTES, 180),

  // "near" tier — from the hot window up to the mid tier.
  nearIntervalMinutes: toInt(process.env.PROP_WATCHER_NEAR_INTERVAL_MINUTES, 60),

  // "hot" tier — the final stretch before kickoff.
  hotWindowMinutesBeforeStart: toInt(process.env.PROP_WATCHER_HOT_WINDOW_MINUTES_BEFORE_START, 60),
  hotIntervalMinutes:          toInt(process.env.PROP_WATCHER_HOT_INTERVAL_MINUTES, 10),

  // "live" tier — game in progress (status === LIVE).
  liveIntervalMinutes: toInt(process.env.PROP_WATCHER_LIVE_INTERVAL_MINUTES, 10),

  // Cold-game cadence — applied when a game is NOT engaged. Cold games skip
  // the far tier and get a much sparser hot/live refresh.
  coldHotIntervalMinutes:  toInt(process.env.PROP_WATCHER_COLD_HOT_INTERVAL_MINUTES, 60),
  coldLiveIntervalMinutes: toInt(process.env.PROP_WATCHER_COLD_LIVE_INTERVAL_MINUTES, 60),
  // A game is treated as pollable for at most this long past kickoff — a safety
  // bound so a game stuck in LIVE doesn't poll forever (postGameSync normally
  // finalizes ~3.5h after start).
  livePollWindowHours: toInt(process.env.PROP_WATCHER_LIVE_POLL_WINDOW_HOURS, 6),
};

const LIVE_STATUS = 'live';

const minutesSince = (date, now) => {
  if (!date) return Infinity;
  const ts = new Date(date).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return (now.getTime() - ts) / 60000;
};

const hoursUntil = (date, now) => {
  if (!date) return 0;
  const ts = new Date(date).getTime();
  if (!Number.isFinite(ts)) return 0;
  return (ts - now.getTime()) / 3600000;
};

/**
 * Refresh interval (minutes) for a SCHEDULED game by hours-to-start,
 * or null when it should not be fetched this cycle.
 *
 * @param {number}  hrsToStart
 * @param {boolean} engaged    engaged games get the fast hot cadence + the far
 *                             tier; cold games get a sparse hot and no far tier.
 */
function _scheduledIntervalMinutes(hrsToStart, engaged) {
  // Beyond the refresh window — tracked only, no credits spent yet.
  if (hrsToStart > POLICY.refreshWindowHours) return null;

  // Final hour before kickoff — also covers a game whose start time has just
  // passed but which postGameSync has not yet flipped to LIVE.
  if (hrsToStart <= POLICY.hotWindowMinutesBeforeStart / 60) {
    return engaged ? POLICY.hotIntervalMinutes : POLICY.coldHotIntervalMinutes;
  }
  // near: hot edge .. 6h  (same cadence for engaged and cold)
  if (hrsToStart <= POLICY.midTierFromHours) return POLICY.nearIntervalMinutes;
  // mid: 6h .. 12h        (same cadence for engaged and cold)
  if (hrsToStart <= POLICY.farTierFromHours) return POLICY.midIntervalMinutes;
  // far: 12h .. 30h — engaged games only; cold games wait until the mid tier.
  if (hrsToStart <= POLICY.refreshWindowHours) {
    return engaged ? POLICY.farIntervalMinutes : null;
  }
  return null;
}

/**
 * startTime window for a propWatcher's Game.find() query.
 *
 * Loads the full TRACK window ahead (48h) so all near-future games are known
 * to the watcher, and reaches back far enough to keep in-progress LIVE games
 * in the working set until they finalize. shouldFetchPropsForGame() then gates
 * which loaded games actually get a props fetch this cycle.
 */
function getPropFetchWindow(now = new Date()) {
  return {
    start: new Date(now.getTime() - POLICY.livePollWindowHours * 3600000),
    end:   new Date(now.getTime() + POLICY.trackWindowHours * 3600000),
  };
}

/**
 * Should this game's props be refreshed right now?
 *
 * @param {object} game
 * @param {Date}   now
 * @param {object} [opts]
 * @param {boolean} [opts.engaged=true]  engaged games (insights / recent views)
 *        get the fast 10m hot/live cadence + the far tier; cold games get a
 *        sparse hot/live cadence and skip the far tier.
 *
 *  • LIVE games          — every ~10m (engaged) / ~60m (cold) while in progress
 *  • scheduled, ≤1h out  — every ~10m (engaged) / ~60m (cold)
 *  • scheduled, 1-12h    — tiered: near 60m / mid 3h  (engaged and cold alike)
 *  • scheduled, 12-30h   — far 6h, engaged only; cold games wait
 *  • scheduled, >30h out — tracked only, never fetched
 *  • games long past the live window — done
 */
function shouldFetchPropsForGame(game, now = new Date(), opts = {}) {
  if (!game) return false;

  const engaged = opts.engaged !== false; // default engaged (no filter applied)

  const startTs = new Date(game.startTime).getTime();
  if (!Number.isFinite(startTs)) return false;

  const hrsToStart = hoursUntil(game.startTime, now);

  // Long past kickoff — game is over (or stuck); stop polling.
  if (hrsToStart < -POLICY.livePollWindowHours) return false;

  const isLive = String(game.status || '').toLowerCase() === LIVE_STATUS;

  // LIVE games are polled by status, not by the clock. Scheduled games follow
  // the time-tiered cadence. Engagement selects the fast vs sparse cadence.
  let intervalMinutes;
  if (isLive) {
    intervalMinutes = engaged ? POLICY.liveIntervalMinutes : POLICY.coldLiveIntervalMinutes;
  } else {
    intervalMinutes = _scheduledIntervalMinutes(hrsToStart, engaged);
  }

  if (intervalMinutes == null) return false;

  // First fetch once it's pollable — populate props now.
  if (!game.propsLastFetchedAt) return true;

  return minutesSince(game.propsLastFetchedAt, now) >= intervalMinutes;
}

module.exports = { shouldFetchPropsForGame, getPropFetchWindow };

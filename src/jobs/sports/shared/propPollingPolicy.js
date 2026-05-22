/**
 * propPollingPolicy.js
 *
 * Central policy for deciding WHETHER and HOW OFTEN to refresh a game's props.
 *
 * Two distinct windows:
 *   • TRACK window  (48h) — games this far out are loaded/known by the watcher
 *     so they appear in the system, but their props are NOT fetched yet.
 *   • REFRESH window (30h) — once a game crosses into this window the watcher
 *     starts spending Odds-API credits on it.
 *
 * Inside the refresh window the cadence is TIERED by time-to-start — frequent
 * near kickoff, sparse far out:
 *
 *     12h .. 30h   "far"   — every 6h
 *      6h .. 12h   "mid"   — every 3h
 *    1.5h .. 6h    "near"  — every 60m
 *   -90m .. +60m   "hot"   — every 25m   (around kickoff, lines move fastest)
 *   +60m .. +180m  "tail"  — every 45m, then polling stops
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
  // ...but props are only refreshed once a game is within this window.
  refreshWindowHours: toInt(process.env.PROP_WATCHER_REFRESH_WINDOW_HOURS, 30),

  // "far" tier — from this many hours out up to the refresh window edge.
  farTierFromHours:    toInt(process.env.PROP_WATCHER_FAR_TIER_FROM_HOURS, 12),
  farIntervalMinutes:  toInt(process.env.PROP_WATCHER_FAR_INTERVAL_MINUTES, 360),

  // "mid" tier — from this many hours out up to the far tier.
  midTierFromHours:    toInt(process.env.PROP_WATCHER_MID_TIER_FROM_HOURS, 6),
  midIntervalMinutes:  toInt(process.env.PROP_WATCHER_MID_INTERVAL_MINUTES, 180),

  // "near" tier — from the hot window up to the mid tier.
  nearIntervalMinutes: toInt(process.env.PROP_WATCHER_NEAR_INTERVAL_MINUTES, 60),

  // "hot" tier — straddles kickoff.
  hotWindowMinutesBeforeStart: toInt(process.env.PROP_WATCHER_HOT_WINDOW_MINUTES_BEFORE_START, 90),
  hotWindowMinutesAfterStart:  toInt(process.env.PROP_WATCHER_HOT_WINDOW_MINUTES_AFTER_START, 60),
  hotIntervalMinutes:          toInt(process.env.PROP_WATCHER_HOT_MIN_INTERVAL_MINUTES, 25),

  // "tail" tier — after the hot window; polling stops past it.
  tailWindowMinutesAfterStart: toInt(process.env.PROP_WATCHER_TAIL_WINDOW_MINUTES_AFTER_START, 180),
  tailIntervalMinutes:         toInt(process.env.PROP_WATCHER_TAIL_MIN_INTERVAL_MINUTES, 45),
};

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
 * Resolve the refresh tier for a given hours-to-start.
 * @returns {{ tier: string, intervalMinutes: number } | null}
 *          null when the game is outside the pollable range.
 */
function _resolveTier(hrsToStart) {
  const hotBefore = POLICY.hotWindowMinutesBeforeStart / 60;
  const hotAfter  = POLICY.hotWindowMinutesAfterStart / 60;
  const tailAfter = POLICY.tailWindowMinutesAfterStart / 60;

  // hot — straddles kickoff (checked first; it overlaps the near band)
  if (hrsToStart <= hotBefore && hrsToStart >= -hotAfter) {
    return { tier: 'hot', intervalMinutes: POLICY.hotIntervalMinutes };
  }
  // tail — after the hot window, until polling stops
  if (hrsToStart < -hotAfter && hrsToStart >= -tailAfter) {
    return { tier: 'tail', intervalMinutes: POLICY.tailIntervalMinutes };
  }
  // near — from hot upper edge out to the mid tier
  if (hrsToStart <= POLICY.midTierFromHours) {
    return { tier: 'near', intervalMinutes: POLICY.nearIntervalMinutes };
  }
  // mid
  if (hrsToStart <= POLICY.farTierFromHours) {
    return { tier: 'mid', intervalMinutes: POLICY.midIntervalMinutes };
  }
  // far — out to the refresh window edge
  if (hrsToStart <= POLICY.refreshWindowHours) {
    return { tier: 'far', intervalMinutes: POLICY.farIntervalMinutes };
  }
  return null;
}

/**
 * startTime window for a propWatcher's Game.find() query.
 *
 * Loads the full TRACK window (48h) so all near-future games are known to the
 * watcher; shouldFetchPropsForGame() then gates which of them actually get a
 * props fetch this cycle.
 */
function getPropFetchWindow(now = new Date()) {
  return {
    start: new Date(now.getTime() - POLICY.tailWindowMinutesAfterStart * 60000),
    end:   new Date(now.getTime() + POLICY.trackWindowHours * 3600000),
  };
}

/**
 * Should this game's props be refreshed right now?
 *
 *  • games beyond the refresh window (30h) are tracked but never fetched
 *  • games past the tail window are done
 *  • otherwise: fetch if no props yet, or if the tier interval has elapsed
 */
function shouldFetchPropsForGame(game, now = new Date()) {
  if (!game) return false;

  const startTs = new Date(game.startTime).getTime();
  if (!Number.isFinite(startTs)) return false;

  const hrsToStart = hoursUntil(game.startTime, now);

  // Beyond the refresh window — tracked only, no credits spent yet.
  if (hrsToStart > POLICY.refreshWindowHours) return false;
  // Past the tail window — game long over, stop polling.
  if (hrsToStart < -(POLICY.tailWindowMinutesAfterStart / 60)) return false;

  const tier = _resolveTier(hrsToStart);
  if (!tier) return false;

  // First fetch once it's inside the refresh window — populate props now.
  if (!game.propsLastFetchedAt) return true;

  return minutesSince(game.propsLastFetchedAt, now) >= tier.intervalMinutes;
}

module.exports = { shouldFetchPropsForGame, getPropFetchWindow, _resolveTier };

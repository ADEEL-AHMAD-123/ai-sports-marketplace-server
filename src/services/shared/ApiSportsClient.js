/**
 * ApiSportsClient.js — Shared HTTP client for all API-Sports endpoints
 *
 * Single key works for ALL sports:
 *   NBA  → https://v2.nba.api-sports.io       header: x-apisports-key
 *   MLB  → https://v1.baseball.api-sports.io  header: x-apisports-key
 *   NHL  → https://v1.hockey.api-sports.io    header: x-apisports-key
 *   NFL  → https://v1.american-football.api-sports.io
 *
 * Free tier: 100 requests/day per sport
 * Paid tier: starts at $10/mo for more requests
 *
 * ADDING A NEW SPORT:
 *   1. Add its BASE_URLS entry below
 *   2. Create /services/sports/{sport}/{Sport}Adapter.js
 *   3. Use this.client = new ApiSportsClient('mlb') in constructor
 *   Done — all caching, error handling, logging inherited automatically
 */

const axios  = require('axios');
const logger = require('../../config/logger');

const BASE_URLS = {
  nba:    'https://v2.nba.api-sports.io',
  mlb:    'https://v1.baseball.api-sports.io',
  nhl:    'https://v1.hockey.api-sports.io',
  nfl:    'https://v1.american-football.api-sports.io',
  soccer: 'https://v3.football.api-sports.io',
};

// Daily request counter (resets at midnight UTC — matches API-Sports reset)
const dailyCounters = {};
const FREE_TIER_DAILY_LIMIT = Number(process.env.API_SPORTS_DAILY_LIMIT) || 100;

// Per-minute rate limiter — sliding window per sport
// API-Football Pro allows ~30 req/min; we use 25 to stay safely under
const RATE_LIMIT_PER_MINUTE = {
  soccer: 25,  // API-Football Pro: 30/min — use 25 to be safe
};
const rateLimitWindows = {}; // sport -> array of timestamps (ms) of recent calls

function _acquireRateSlot(sport) {
  const limit = RATE_LIMIT_PER_MINUTE[sport];
  if (!limit) return Promise.resolve(); // no throttle for other sports

  if (!rateLimitWindows[sport]) rateLimitWindows[sport] = [];
  const window = rateLimitWindows[sport];
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Purge timestamps older than 1 minute
  while (window.length && window[0] <= oneMinuteAgo) window.shift();

  if (window.length < limit) {
    window.push(now);
    return Promise.resolve();
  }

  // Window is full — wait until the oldest slot falls outside the 1-min window
  const waitMs = window[0] + 60_000 - now + 50; // +50ms buffer
  logger.debug(`[ApiSports/${sport}] Rate limit window full (${window.length}/${limit}), waiting ${waitMs}ms`);
  return new Promise(resolve => setTimeout(() => {
    // Re-enter after wait to register the slot correctly
    _acquireRateSlot(sport).then(resolve);
  }, waitMs));
}

class ApiSportsClient {
  constructor(sport) {
    this.sport   = sport;
    this.baseUrl = BASE_URLS[sport];
    this.apiKey  = process.env.API_SPORTS_KEY
               || process.env.API_NBA_KEY;  // backward compat

    if (!this.apiKey) {
      logger.warn(`[ApiSports/${sport}] No API key found. Set API_SPORTS_KEY in .env`);
    }
    if (!this.baseUrl) {
      throw new Error(`[ApiSports] Unknown sport: "${sport}". Add to BASE_URLS.`);
    }

    this._initDayCounter();
  }

  _initDayCounter() {
    const today = new Date().toISOString().slice(0, 10);
    if (!dailyCounters[this.sport]) {
      dailyCounters[this.sport] = { date: today, count: 0 };
    } else if (dailyCounters[this.sport].date !== today) {
      dailyCounters[this.sport] = { date: today, count: 0 };
    }
  }

  _checkDailyLimit() {
    this._initDayCounter();
    const c = dailyCounters[this.sport];
    if (c.count >= FREE_TIER_DAILY_LIMIT) {
      logger.warn(`[ApiSports/${this.sport}] Daily limit reached (${c.count}/${FREE_TIER_DAILY_LIMIT}). Skipping call.`);
      return false;
    }
    return true;
  }

  async get(endpoint, params = {}) {
    if (!this._checkDailyLimit()) return null;

    // Enforce per-minute rate limit before making the call
    await _acquireRateSlot(this.sport);

    const url = `${this.baseUrl}/${endpoint}`;
    try {
      const res = await axios.get(url, {
        headers: { 'x-apisports-key': this.apiKey },
        params,
        timeout: 10000,
      });

      dailyCounters[this.sport].count++;
      const remaining = res.headers?.['x-ratelimit-requests-remaining'];
      if (remaining !== undefined) {
        logger.debug(`[ApiSports/${this.sport}] Quota remaining today: ${remaining}`);
      }

      return res.data?.response || [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        logger.error(`[ApiSports/${this.sport}] 401 — invalid API key`);
        return null;
      }
      if (status === 429) {
        // Shouldn't happen with rate limiter, but back off and retry once
        const retryAfter = Number(err.response?.headers?.['retry-after'] || 5);
        logger.warn(`[ApiSports/${this.sport}] 429 — backing off ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return this.get(endpoint, params);
      }
      logger.error(`[ApiSports/${this.sport}] ${endpoint} failed`, { status, error: err.message });
      throw err;
    }
  }

  getDailyUsage() {
    return dailyCounters[this.sport] || { count: 0 };
  }
}

module.exports = ApiSportsClient;
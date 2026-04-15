/**
 * constants.js — Application-wide constants
 *
 * Centralizes all magic strings, enums, and config values.
 * This makes the codebase easy to update — change here, reflects everywhere.
 *
 * Rule: NEVER hardcode these values in controllers/services/adapters.
 */

// ─── Supported sports ──────────────────────────────────────────────────────────
const SPORTS = {
  NBA: 'nba', NFL: 'nfl', MLB: 'mlb', NHL: 'nhl', SOCCER: 'soccer',
};

const SPORT_LABELS = {
  [SPORTS.NBA]: 'NBA Basketball', [SPORTS.NFL]: 'NFL Football',
  [SPORTS.MLB]: 'MLB Baseball',   [SPORTS.NHL]: 'NHL Hockey', [SPORTS.SOCCER]: 'Soccer',
};

const ACTIVE_SPORTS = [SPORTS.NBA];

// ─── Bet market types ──────────────────────────────────────────────────────────
const MARKET_TYPES = {
  PLAYER_PROP: 'player_prop', SPREAD: 'spread',
  MONEYLINE: 'moneyline',     TOTAL: 'total',
};

const BET_DIRECTION = { OVER: 'over', UNDER: 'under' };

// ─── Insight status ────────────────────────────────────────────────────────────
const INSIGHT_STATUS = {
  PENDING: 'pending', GENERATED: 'generated',
  FAILED: 'failed',   STALE: 'stale',
};

// ─── Credits ───────────────────────────────────────────────────────────────────
const CREDITS = {
  FREE_ON_SIGNUP:   parseInt(process.env.FREE_CREDITS_ON_SIGNUP || '3', 10),
  COST_PER_INSIGHT: parseInt(process.env.CREDITS_PER_INSIGHT    || '1', 10),
};

const CREDIT_PACKS = [
  { id: 'pack_1',  priceId: process.env.STRIPE_PRICE_1_CREDIT,  credits: 1, amount: 0.99, label: '1 Credit — $0.99'  },
  { id: 'pack_6',  priceId: process.env.STRIPE_PRICE_6_CREDITS, credits: 6, amount: 4.99, label: '6 Credits — $4.99' },
];

// ─── Cache TTL (seconds) ───────────────────────────────────────────────────────
const CACHE_TTL = {
  ODDS:     parseInt(process.env.REDIS_TTL_ODDS      || '300',  10), // 5 min
  SCHEDULE: parseInt(process.env.REDIS_TTL_SCHEDULE  || '3600', 10), // 1 hr
  PROPS:    parseInt(process.env.REDIS_TTL_PROPS      || '600',  10), // 10 min
};

const CACHE_KEYS = {
  ODDS: 'odds', SCHEDULE: 'schedule', PROPS: 'props', PLAYER_STATS: 'player_stats',
};

const ODDS_CHANGE_THRESHOLD = 1.0;

// ─── Three-window stat model ───────────────────────────────────────────────────
//
// Peter St John's insight: one window can't answer two different questions.
// We use three separate windows, each with a specific purpose:
//
// FORM_WINDOW (5 games)
//   → "What is this player doing RIGHT NOW?"
//   → Detects: injury returns, hot/cold streaks, role changes, load management
//   → Used for: confidenceScore (hit rate), recentStatValues (sparkline)
//   → Why 5: Small enough to be truly current. 10 would include pre-injury context.
//
// EDGE_WINDOW (10 games)
//   → "What is the player's reliable recent average?"
//   → Smooths variance from FORM_WINDOW while staying recent
//   → Used for: edgePercentage (focusStatAvg vs line), focusStatAvg shown in modal
//   → Why 10: Balances recency vs noise. 5 is too volatile for an edge calculation.
//
// BASELINE_WINDOW (30 games)
//   → "What does the bookmaker's line reflect?"
//   → Books set lines on season-long trends, not last week
//   → Used for: TS%, eFG%, USG% (need large sample), baselineStatAvg for AI context
//   → Why 30: ~2.5 months of games. Enough for efficiency stats to be meaningful.
//
// MIN_GAMES_REQUIRED (10)
//   → Hide prop card if player has fewer than this many NBA games
//   → Prevents misleading analysis on rookies / returning players
//   → No college stats fallback — books don't price NBA lines from college data
//
const FORM_WINDOW         = 5;   // confidence score + sparkline
const EDGE_WINDOW         = 10;  // edge % + focusStatAvg
const BASELINE_WINDOW     = 30;  // efficiency metrics + AI baseline context
const MIN_GAMES_REQUIRED  = 10;  // hide prop if fewer games available

// Kept for backward compatibility (CONFIDENCE_WINDOW referenced in StrategyService)
const CONFIDENCE_WINDOW   = FORM_WINDOW;
const MIN_CONFIDENCE_HITS = Math.ceil(FORM_WINDOW * 0.8); // 80% hit rate = HC (4/5)
const MIN_EDGE_PERCENTAGE = 15; // |edge| >= 15% = Best Value tag

// ─── User roles ────────────────────────────────────────────────────────────────
const USER_ROLES = { USER: 'user', ADMIN: 'admin' };

// ─── Transaction types ─────────────────────────────────────────────────────────
const TRANSACTION_TYPES = {
  SIGNUP_BONUS:   'signup_bonus',
  PURCHASE:       'purchase',
  INSIGHT_UNLOCK: 'insight_unlock',
  REFUND:         'refund',
  ADMIN_GRANT:    'admin_grant',
};

// ─── HTTP status codes ─────────────────────────────────────────────────────────
const HTTP_STATUS = {
  OK: 200, CREATED: 201, NO_CONTENT: 204,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429, INTERNAL_ERROR: 500, SERVICE_UNAVAILABLE: 503,
};

// ─── AI prompt constants ────────────────────────────────────────────────────────
const AI_PROMPT = {
  SYSTEM_ROLE: `You are an expert sports analytics AI. Your job is to analyze \nplayer statistics and betting lines to provide sharp, data-driven betting insights.\nBe concise, specific, and always reference the statistical evidence behind your recommendation.\nNever give generic advice. Always give a clear OVER or UNDER recommendation with reasoning.`,
};

module.exports = {
  SPORTS, SPORT_LABELS, ACTIVE_SPORTS,
  MARKET_TYPES, BET_DIRECTION, INSIGHT_STATUS,
  CREDITS, CREDIT_PACKS, CACHE_TTL, CACHE_KEYS,
  ODDS_CHANGE_THRESHOLD,
  // Three-window model
  FORM_WINDOW, EDGE_WINDOW, BASELINE_WINDOW, MIN_GAMES_REQUIRED,
  // Backward compat aliases
  CONFIDENCE_WINDOW, MIN_CONFIDENCE_HITS, MIN_EDGE_PERCENTAGE,
  USER_ROLES, TRANSACTION_TYPES, HTTP_STATUS, AI_PROMPT,
};
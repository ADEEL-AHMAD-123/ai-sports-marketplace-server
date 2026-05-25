/**
 * propEngagement.js
 *
 * Decides which games are "engaged" — worth the expensive 10-minute hot/live
 * prop refresh cadence — versus "cold" games that only need a sparse
 * background refresh.
 *
 * Engagement is read straight off the Game document from two markers, each
 * stamped by a genuine user HTTP action:
 *
 *   • propsLastViewedAt    — a user opened this game's props (props endpoint).
 *                            Decays after VIEW_TTL_HOURS.
 *   • propsUserUnlockedAt  — a real user unlocked an insight for this game
 *                            (authenticated unlock endpoint). Sticky for the
 *                            game's lifetime — a paid insight needs fresh
 *                            lines through kickoff.
 *
 * IMPORTANT — why this does NOT infer engagement from Insight documents:
 * the performance/outcomes pipeline auto-generates ("unlocks") insights for
 * games no user touched, purely to collect grading data. Inferring engagement
 * from "an Insight exists for this game" would mis-flag every such game as
 * engaged. Both markers here are set only by real user requests hitting the
 * HTTP controllers — system auto-unlocks call InsightService directly and
 * never stamp them — so this signal stays correct regardless of how much the
 * performance pipeline auto-generates.
 */

const VIEW_TTL_HOURS = Math.max(
  1,
  parseInt(process.env.PROP_ENGAGEMENT_VIEW_TTL_HOURS || '24', 10)
);

/**
 * Is this single game engaged?
 * @param {object} game  loaded game doc (propsLastViewedAt, propsUserUnlockedAt)
 * @param {Date}   now
 */
function isGameEngaged(game, now = new Date()) {
  if (!game) return false;

  // Sticky: a real user unlocked an insight for this game.
  if (game.propsUserUnlockedAt) return true;

  // Decaying: a user viewed this game's props within the TTL.
  const viewedTs = game.propsLastViewedAt ? new Date(game.propsLastViewedAt).getTime() : NaN;
  if (Number.isFinite(viewedTs)) {
    return viewedTs >= now.getTime() - VIEW_TTL_HOURS * 3600000;
  }
  return false;
}

/**
 * Set of engaged oddsEventIds for a batch of games. Pure — no DB query.
 *
 * @param {Array<object>} games
 * @param {Date}          now
 * @returns {Promise<Set<string>>}
 */
async function getEngagedEventIds(games = [], now = new Date()) {
  const engaged = new Set();
  for (const g of games) {
    if (g?.oddsEventId && isGameEngaged(g, now)) {
      engaged.add(String(g.oddsEventId));
    }
  }
  return engaged;
}

module.exports = { getEngagedEventIds, isGameEngaged };

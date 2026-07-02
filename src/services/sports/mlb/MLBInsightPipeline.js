/**
 * MLBInsightPipeline.js — MLB-specific insight context enrichment
 *
 * Called by InsightService during Step 6 for MLB batter/pitcher props.
 * Returns:
 *   - starterContext    { starterName, starterStats: { …, hand } }
 *   - parkContext       { homeTeamName }               (pitchers + batters)
 *   - platoonContext    { matchup: { batterHand, pitcherHand, edge, note } }
 *   - playerSide        'home' | 'away' | null        (drives opponentName/venue)
 *
 * BATTER-TEAM RESOLUTION (this is the critical piece):
 *   Odds-API props don't carry the player's team, so we cannot infer
 *   home-vs-away from the prop alone. Without it:
 *     - `leagueContext.playerSide` is null (no opponentName/venue),
 *     - and when two starters exist for the game we cannot pick the
 *       correct OPPOSING one (we'd guess the batter's own starter, which
 *       poisons the platoon + starter-quality signal).
 *
 *   Fix: resolve the batter's team via MLB Stats API's people/{id} endpoint
 *   (permanent in-memory cache — one call per player per session), compare
 *   against game.homeTeam.name / game.awayTeam.name, and use the resulting
 *   playerSide to (a) tag home/away starter and (b) populate leagueContext.
 *
 * STARTER RESOLUTION (three tiers):
 *   1. Read `opponentStarterName` off the prop — set by propWatcher's
 *      enrichBatterPropsWithStarter().
 *   2. Cross-check the DB for BOTH pitcher_strikeouts props for this game.
 *      Resolve each pitcher's team → tag home vs away. When we know
 *      playerSide, pick the correct opposing starter (home batter → away
 *      starter, and vice versa). When we don't, fall back to whichever was
 *      already on the prop (or the first pitcher found).
 *   3. Leave null — no starter identified anywhere.
 *
 * PITCHER HAND:
 *   Fetched via MLBPlatoonService.fetchPitcherHand (permanent in-memory
 *   cache). Merged into starterContext.starterStats.hand so leagueContext
 *   surfaces it and the platoon chip lights up.
 *
 * PITCHER PROPS:
 *   Return parkContext (their own start's venue) — batter-side signals are
 *   not applicable, so starterContext and platoonContext are null.
 */

const PlayerProp                        = require('../../../models/PlayerProp.model');
const { getParkFactors }                = require('./MLBBallparkFactors');
const { getPlatoonMatchup, fetchPitcherHand } = require('./MLBPlatoonService');
const { fetchStarterStats }             = require('./MLBStarterService');
const mlbStatsClient                    = require('../../shared/MLBStatsClient');
const logger                            = require('../../../config/logger');

/**
 * Compare two team name strings loosely — MLB Stats API returns full names
 * ("Los Angeles Dodgers"), Odds API sometimes returns the same and sometimes
 * abbreviated forms. We normalize + check substring both ways so "Dodgers"
 * matches "Los Angeles Dodgers".
 */
function _teamNamesMatch(a, b) {
  if (!a || !b) return false;
  const na = String(a).toLowerCase().trim();
  const nb = String(b).toLowerCase().trim();
  if (na === nb) return true;
  // Try last-word (nickname) match: "…Dodgers" ~ "Dodgers"
  const lastA = na.split(/\s+/).pop();
  const lastB = nb.split(/\s+/).pop();
  if (lastA && lastB && lastA === lastB) return true;
  return na.includes(nb) || nb.includes(na);
}

/**
 * Resolve which side of the game a player is on.
 *
 * @returns {Promise<'home'|'away'|null>}
 */
async function _resolvePlayerSide(playerName, homeTeamName, awayTeamName) {
  if (!playerName || (!homeTeamName && !awayTeamName)) return null;
  try {
    const teamName = await mlbStatsClient.resolvePlayerTeamName(playerName);
    if (!teamName) return null;
    if (_teamNamesMatch(teamName, homeTeamName)) return 'home';
    if (_teamNamesMatch(teamName, awayTeamName)) return 'away';
    return null;
  } catch (err) {
    logger.debug('[MLBInsightPipeline] _resolvePlayerSide failed', {
      playerName, error: err.message,
    });
    return null;
  }
}

/**
 * Given a game + all its pitcher_strikeouts props, decide which pitcher
 * starts for the home team and which for the away team by resolving each
 * pitcher's current team. Returns nulls where a mapping can't be made.
 *
 * @returns {Promise<{ homeStarter: string|null, awayStarter: string|null }>}
 */
async function _resolveGameStarters(game) {
  const homeTeamName = game?.homeTeam?.name || null;
  const awayTeamName = game?.awayTeam?.name || null;
  const oddsEventId  = game?.oddsEventId;
  if (!oddsEventId) return { homeStarter: null, awayStarter: null };

  const kProps = await PlayerProp.find({
    sport:       'mlb',
    oddsEventId,
    statType:    'pitcher_strikeouts',
  }).select('playerName').lean();

  if (!kProps.length) return { homeStarter: null, awayStarter: null };

  // Deduplicate by name (same pitcher can appear across O/U lines)
  const uniquePitchers = [...new Set(kProps.map(p => p.playerName).filter(Boolean))];

  let homeStarter = null;
  let awayStarter = null;

  // Resolve each pitcher's team in parallel
  const sides = await Promise.all(
    uniquePitchers.map(name => _resolvePlayerSide(name, homeTeamName, awayTeamName))
  );

  uniquePitchers.forEach((name, i) => {
    if (sides[i] === 'home' && !homeStarter) homeStarter = name;
    if (sides[i] === 'away' && !awayStarter) awayStarter = name;
  });

  // If we had two pitchers but couldn't tag either, fall back to the
  // legacy ordering (first = home, second = away) so downstream still works.
  if (!homeStarter && !awayStarter && uniquePitchers.length >= 2) {
    homeStarter = uniquePitchers[0];
    awayStarter = uniquePitchers[1];
  }

  return { homeStarter, awayStarter };
}

/**
 * @param {{ statType, playerName, oddsEventId }} prop  (can be lean from DB)
 * @param {Object} game — Game document (lean)
 * @returns {Promise<{
 *   starterContext:  Object|null,
 *   parkContext:     Object|null,
 *   platoonContext:  Object|null,
 *   playerSide:      'home'|'away'|null,
 * }>}
 */
async function getInsightContext(prop, game) {
  const isPitcher    = prop.statType === 'pitcher_strikeouts';
  const homeTeamName = game?.homeTeam?.name || null;
  const awayTeamName = game?.awayTeam?.name || null;

  // Park context applies to both pitchers and batters — for pitchers it's
  // the stadium they're pitching in, for batters the venue their AB happens.
  // Expose the actual venue name + park factor so the frontend can render
  // a real "Citizens Bank Park · +6% hitter-friendly" badge, not just the
  // home team's franchise name.
  const parkData = homeTeamName ? getParkFactors(homeTeamName) : null;
  const parkContext = parkData
    ? {
        homeTeamName,
        venueName:  parkData.name       ?? null,
        parkFactor: parkData.parkFactor ?? null,
        hrFactor:   parkData.hrFactor   ?? null,
      }
    : null;

  if (isPitcher) {
    // Pitchers: still resolve THEIR side so leagueContext knows if they're
    // pitching at home or on the road (affects wall/park effects).
    const playerSide = await _resolvePlayerSide(prop.playerName, homeTeamName, awayTeamName);
    return {
      starterContext:  null,
      parkContext,
      platoonContext:  null,
      playerSide,
    };
  }

  // ── Batter path ──────────────────────────────────────────────────────────

  // 1. Resolve batter's side of the game (drives opponent selection).
  const playerSide = await _resolvePlayerSide(prop.playerName, homeTeamName, awayTeamName);

  // 2. Resolve BOTH starters and tag home/away by team.
  const { homeStarter, awayStarter } = await _resolveGameStarters(game);

  // 3. Pick the OPPOSING starter based on batter's side. When playerSide is
  //    unknown, fall back to opponentStarterName off the prop (propWatcher's
  //    best guess), then to whichever starter we found.
  const propDoc = await PlayerProp.findOne({
    oddsEventId: prop.oddsEventId || game?.oddsEventId,
    playerName:  prop.playerName,
    statType:    prop.statType,
  }).select('opponentStarterName opponentStarterStats').lean();

  let starterName  = null;
  let starterStats = null;

  if (playerSide === 'home' && awayStarter) {
    starterName = awayStarter;
  } else if (playerSide === 'away' && homeStarter) {
    starterName = homeStarter;
  } else if (propDoc?.opponentStarterName) {
    starterName  = propDoc.opponentStarterName;
    starterStats = propDoc.opponentStarterStats || null;
  } else {
    starterName = homeStarter || awayStarter || null;
  }

  // 4. Fetch stats on-demand if we don't have them cached on the prop
  //    (either because we picked a different starter than propWatcher, or
  //    because the batter prop was persisted before enrichment ran).
  if (starterName && !starterStats) {
    try {
      starterStats = await fetchStarterStats(starterName);
    } catch (err) {
      logger.debug('[MLBInsightPipeline] Fallback starter stats fetch failed (non-fatal)', {
        starterName,
        error: err.message,
      });
    }
  }

  // 5. Fetch pitcher hand + compute platoon matchup in parallel. Hand is
  //    merged into starterStats so leagueContext.starter.hand is populated.
  let pitcherHand   = null;
  let platoonMatchup = null;
  if (starterName) {
    const [handRes, matchupRes] = await Promise.all([
      fetchPitcherHand(starterName).catch(() => null),
      getPlatoonMatchup(prop.playerName, starterName).catch(() => null),
    ]);
    pitcherHand    = handRes;
    platoonMatchup = matchupRes;
  }

  const enrichedStarterStats = starterStats
    ? { ...starterStats, hand: pitcherHand || starterStats.hand || null }
    : (pitcherHand ? { hand: pitcherHand } : null);

  const starterContext = starterName
    ? { starterName, starterStats: enrichedStarterStats }
    : null;
  const platoonContext = platoonMatchup ? { matchup: platoonMatchup } : null;

  return {
    starterContext,
    parkContext,
    platoonContext,
    playerSide,
  };
}

module.exports = { getInsightContext };

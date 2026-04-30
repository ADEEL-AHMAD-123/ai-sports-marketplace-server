/**
 * MLBPlatoonService.js — MLB L/R platoon split analysis
 *
 * DATA SOURCE: Official MLB Stats API (statsapi.mlb.com) — free, no key.
 *
 * WHAT THIS DOES:
 *  When a batter prop is generated, we know the opposing starter (from MLBStarterService).
 *  This service fetches:
 *    1. The starter's throwing hand (L or R) from /api/v1/people/{id}
 *    2. The batter's career splits vs LHP and vs RHP from /api/v1/people/{id}/stats?stats=statSplits
 *  Then computes the platoon advantage/disadvantage and adds it to the AI prompt.
 *
 * WHY THIS MATTERS (most predictable edge in MLB betting):
 *  R batter vs L pitcher: typically +15-20% higher avg than vs R pitcher
 *  L batter vs R pitcher: typically +10-15% higher avg than vs L pitcher
 *  Same-hand matchup (R vs R, L vs L): typically 5-10% below career avg
 *
 *  Example: Aaron Judge (R) vs Cole Ragans (L):
 *    Judge career vs LHP: .310 avg | vs RHP: .268 avg
 *    Matchup avg (.310) is .042 above overall → OVER lean confirmed
 *
 * CACHE STRATEGY:
 *  Batter splits: 24h cache (season splits change slowly)
 *  Pitcher hand:  permanent in-memory (handedness never changes)
 *
 * ENDPOINTS:
 *  Batter splits: GET /api/v1/people/{id}/stats?stats=statSplits&group=hitting&season={year}
 *    response.stats[0].splits → array of split objects
 *    split.split.code 'vl' = vs LHP | 'vr' = vs RHP
 *    split.stat: { avg, obp, slg, ops, hits, atBats, doubles, triples, homeRuns }
 *
 *  Pitcher hand: GET /api/v1/people/{id}?fields=people,pitchHand,batSide
 *    response.people[0].pitchHand.code → 'R' | 'L' | 'S'
 *    response.people[0].batSide.code  → 'R' | 'L' | 'S' (batter's side)
 */

const logger         = require('../../../config/logger');
const mlbStatsClient = require('../../shared/MLBStatsClient');
const { cacheGet, cacheSet } = require('../../../config/redis');

const SPLITS_CACHE_TTL = 24 * 60 * 60;     // 24h — season splits change slowly
const pitcherHandCache = new Map();          // permanent in-memory — handedness never changes
const batterHandCache  = new Map();          // permanent in-memory

// ─── Pitcher handedness ────────────────────────────────────────────────────────

/**
 * Get a pitcher's throwing hand.
 * @param {string} pitcherName
 * @returns {Promise<'L'|'R'|'S'|null>} L=left, R=right, S=switch, null=unknown
 */
async function fetchPitcherHand(pitcherName) {
  if (!pitcherName) return null;

  const norm = pitcherName.toLowerCase().trim();
  if (pitcherHandCache.has(norm)) return pitcherHandCache.get(norm);

  try {
    const mlbId = await mlbStatsClient.findPlayerId(pitcherName);
    if (!mlbId) return null;

    const res = await mlbStatsClient._getPersonDetails(mlbId);
    const hand = res?.pitchHand?.code || null;

    if (hand) {
      pitcherHandCache.set(norm, hand);
      logger.debug(`[PlatoonService] Pitcher hand: ${pitcherName} → ${hand}`);
    }
    return hand;
  } catch (err) {
    logger.warn('[PlatoonService] fetchPitcherHand failed', { pitcherName, error: err.message });
    return null;
  }
}

// ─── Batter handedness ─────────────────────────────────────────────────────────

/**
 * Get a batter's batting side.
 * @param {string} batterName
 * @param {number|null} mlbId - optional pre-resolved MLBAM ID
 * @returns {Promise<'L'|'R'|'S'|null>}
 */
async function fetchBatterHand(batterName, mlbId = null) {
  if (!batterName) return null;

  const norm = batterName.toLowerCase().trim();
  if (batterHandCache.has(norm)) return batterHandCache.get(norm);

  try {
    const id = mlbId || await mlbStatsClient.findPlayerId(batterName);
    if (!id) return null;

    const res  = await mlbStatsClient._getPersonDetails(id);
    const side = res?.batSide?.code || null;

    if (side) {
      batterHandCache.set(norm, side);
      logger.debug(`[PlatoonService] Batter hand: ${batterName} → ${side}`);
    }
    return side;
  } catch (err) {
    logger.warn('[PlatoonService] fetchBatterHand failed', { batterName, error: err.message });
    return null;
  }
}

// ─── Batter platoon splits ─────────────────────────────────────────────────────

/**
 * Get batter's season splits vs LHP and vs RHP.
 *
 * @param {string} batterName
 * @returns {Promise<{ vsLHP: Object|null, vsRHP: Object|null }>}
 *   Each split: { avg, obp, slg, ops, hits, atBats } (null if insufficient ABs)
 */
async function fetchBatterSplits(batterName) {
  if (!batterName) return { vsLHP: null, vsRHP: null };

  const season   = new Date().getFullYear();
  const cacheKey = `mlb:platoon:splits:${batterName.toLowerCase().replace(/\s+/g, '_')}:${season}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const mlbId = await mlbStatsClient.findPlayerId(batterName);
    if (!mlbId) {
      await cacheSet(cacheKey, { vsLHP: null, vsRHP: null }, SPLITS_CACHE_TTL);
      return { vsLHP: null, vsRHP: null };
    }

    const res = await mlbStatsClient._getStatSplits(mlbId, season, 'hitting');
    const splits = res || [];

    const vsLHP = _extractSplit(splits, 'vl');
    const vsRHP = _extractSplit(splits, 'vr');

    // Require at least 30 AB in a split to trust it — small sample is noise
    const result = {
      vsLHP: vsLHP && (vsLHP.atBats || 0) >= 30 ? vsLHP : null,
      vsRHP: vsRHP && (vsRHP.atBats || 0) >= 30 ? vsRHP : null,
    };

    await cacheSet(cacheKey, result, SPLITS_CACHE_TTL);
    logger.debug('[PlatoonService] Splits fetched', {
      batterName,
      vsLHP: result.vsLHP?.avg,
      vsRHP: result.vsRHP?.avg,
    });

    return result;
  } catch (err) {
    logger.warn('[PlatoonService] fetchBatterSplits failed', { batterName, error: err.message });
    await cacheSet(cacheKey, { vsLHP: null, vsRHP: null }, SPLITS_CACHE_TTL);
    return { vsLHP: null, vsRHP: null };
  }
}

function _extractSplit(splits, code) {
  const match = splits.find(s => s.split?.code === code);
  if (!match?.stat) return null;
  const { avg, obp, slg, ops, hits, atBats, doubles, triples, homeRuns } = match.stat;
  return {
    avg:      parseFloat(avg)  || null,
    obp:      parseFloat(obp)  || null,
    slg:      parseFloat(slg)  || null,
    ops:      parseFloat(ops)  || null,
    hits:     hits     || 0,
    atBats:   atBats   || 0,
    doubles:  doubles  || 0,
    triples:  triples  || 0,
    homeRuns: homeRuns || 0,
  };
}

// ─── Main matchup analysis ─────────────────────────────────────────────────────

/**
 * Compute the platoon matchup context for a batter vs starter.
 *
 * @param {string} batterName
 * @param {string} starterName
 * @returns {Promise<Object|null>} Matchup data or null if insufficient data
 */
async function getPlatoonMatchup(batterName, starterName) {
  if (!batterName || !starterName) return null;

  try {
    // Fetch all data in parallel
    const [splits, pitcherHand, batterHand] = await Promise.all([
      fetchBatterSplits(batterName),
      fetchPitcherHand(starterName),
      fetchBatterHand(batterName),
    ]);

    if (!pitcherHand) {
      logger.debug('[PlatoonService] No pitcher hand data', { starterName });
      return null;
    }

    // Determine which split applies to this matchup
    // Pitcher throws R → batter is facing RHP → use vsRHP split
    // Pitcher throws L → batter is facing LHP → use vsLHP split
    // Switch pitcher: rare, treat as R for analysis
    const effectiveHand    = pitcherHand === 'L' ? 'L' : 'R';
    const matchupSplit     = effectiveHand === 'L' ? splits.vsLHP : splits.vsRHP;
    const oppositeSplit    = effectiveHand === 'L' ? splits.vsRHP : splits.vsLHP;

    if (!matchupSplit) {
      logger.debug('[PlatoonService] Insufficient splits data', { batterName, effectiveHand });
      return null;
    }

    // Compute platoon delta: how much better/worse this batter hits in this matchup
    const matchupAvg  = matchupSplit.avg;
    const oppositeAvg = oppositeSplit?.avg || null;

    // Overall career avg estimated as weighted average of both splits
    let overallAvg = null;
    if (matchupSplit.atBats && oppositeSplit?.atBats) {
      const totalAB = matchupSplit.atBats + oppositeSplit.atBats;
      const totalH  = matchupSplit.hits + (oppositeSplit.hits || 0);
      overallAvg    = totalAB > 0 ? parseFloat((totalH / totalAB).toFixed(3)) : null;
    }

    // Delta: positive = batter BETTER in this matchup, negative = worse
    const delta = (matchupAvg && overallAvg)
      ? parseFloat((matchupAvg - overallAvg).toFixed(3)) : null;

    // Classify advantage
    let advantage = 'neutral';
    if (delta !== null) {
      if (delta >= 0.025)       advantage = 'strong_favor';   // >25pt avg boost
      else if (delta >= 0.010)  advantage = 'slight_favor';   // 10-25pt boost
      else if (delta <= -0.025) advantage = 'strong_against'; // >25pt penalty
      else if (delta <= -0.010) advantage = 'slight_against'; // 10-25pt penalty
    }

    // Typical platoon splits by batter hand for context label
    // If we don't have splits data, provide league average expectation
    const typicalLabel = _getTypicalPlatoonLabel(batterHand, effectiveHand);

    return {
      batterName,
      starterName,
      batterHand:    batterHand  || 'unknown',
      pitcherHand:   pitcherHand || 'unknown',
      matchupLabel:  `${batterHand || '?'} batter vs ${effectiveHand} pitcher`,
      matchupAvg,
      oppositeAvg,
      overallAvg,
      delta,
      advantage,
      matchupABs:    matchupSplit.atBats,
      matchupOBP:    matchupSplit.obp,
      matchupSLG:    matchupSplit.slg,
      typicalLabel,
    };
  } catch (err) {
    logger.warn('[PlatoonService] getPlatoonMatchup failed', {
      batterName, starterName, error: err.message,
    });
    return null;
  }
}

function _getTypicalPlatoonLabel(batterHand, pitcherHand) {
  if (!batterHand || batterHand === 'unknown') return '';
  const favorable = (batterHand === 'R' && pitcherHand === 'L')
    || (batterHand === 'L' && pitcherHand === 'R');
  if (favorable) return 'Cross-hand matchup (typically favorable — avg boost expected)';
  if (batterHand === pitcherHand) return 'Same-hand matchup (typically neutral to slight disadvantage)';
  return '';
}

// ─── Prompt block ──────────────────────────────────────────────────────────────

/**
 * Build the platoon context block for the AI prompt.
 *
 * @param {Object|null} matchup - Output of getPlatoonMatchup()
 * @returns {string} Formatted prompt block or ''
 */
function buildPlatoonBlock(matchup) {
  if (!matchup) return '';

  const { matchupLabel, matchupAvg, oppositeAvg, overallAvg, delta, advantage, matchupABs } = matchup;

  if (!matchupAvg) return '';

  const leanEmoji = {
    strong_favor:   '🟢',
    slight_favor:   '🟡',
    neutral:        '⚪',
    slight_against: '🟡',
    strong_against: '🔴',
  }[advantage] || '⚪';

  const leanStr = {
    strong_favor:   'FAVORABLE (+' + Math.round((delta || 0) * 1000) + ' OPS pts) → lean OVER on hits/TB',
    slight_favor:   'slight advantage (+' + Math.round((delta || 0) * 1000) + ' pts) → mild OVER lean',
    neutral:        'neutral matchup — no platoon adjustment',
    slight_against: 'slight disadvantage (' + Math.round((delta || 0) * 1000) + ' pts) → mild UNDER lean',
    strong_against: 'UNFAVORABLE (' + Math.round((delta || 0) * 1000) + ' pts) → lean UNDER on hits/TB',
  }[advantage] || 'neutral';

  const abNote   = matchupABs ? ` (${matchupABs} AB sample)` : '';
  const oppNote  = oppositeAvg ? ` | vs opposite hand: .${String(oppositeAvg).replace('.', '').padStart(3, '0')}` : '';

  return [
    `PLATOON MATCHUP: ${matchupLabel}`,
    `  ${leanEmoji} ${leanStr}`,
    `  Batter avg vs this pitcher hand: .${String(matchupAvg).replace('.', '').padStart(3, '0')}${abNote}${oppNote}`,
    matchup.typicalLabel ? `  Context: ${matchup.typicalLabel}` : '',
    '  Platoon splits are highly consistent — factor into hits/TB/OBP props.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  fetchPitcherHand,
  fetchBatterHand,
  fetchBatterSplits,
  getPlatoonMatchup,
  buildPlatoonBlock,
};
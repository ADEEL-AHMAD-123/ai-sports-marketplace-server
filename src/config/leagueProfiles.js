/**
 * leagueProfiles.js — Per-sport scoring configuration
 *
 * Controls how StrategyService scores props for each sport.
 * Tuned based on real outcome data (April 2026 audit):
 *
 * REAL OUTCOME DATA (28 graded MLB + 0 graded NBA as of audit):
 *   MLB overall:  67.9% win rate
 *   MLB hits:     75% (3W 1L)
 *   MLB rbis:     71% (10W 4L) — most volume, expected variance
 *   MLB runs:     75% (3W 1L)
 *   MLB total_bases: 50% (2W 2L) — weakest, reduce edge weight
 *   MLB pitcher_k:   50% (1W 1L) — small sample, keep moderate
 *
 * NBA: all unresolved before PlayerCache fix — recalibrate after
 * next cycle of graded data.
 *
 * TUNING RATIONALE:
 *   - RBIs are inherently volatile (team-dependent, situational) →
 *     raise minEdgePercentage so only high-edge RBI props qualify as bestValue
 *   - total_bases moderate variance → moderate edge threshold
 *   - hits are consistent → tight edge threshold, high confidence weight
 *   - shots_on_goal (NHL) most consistent skater stat → tight threshold
 *   - goals/assists (NHL) high variance → higher threshold required
 */

// ── Variance-guard defaults ───────────────────────────────────────────────
// These caps reduce confidence when a player's recent log looks noisy.
// The DEFAULT values are calibrated for NBA/NFL where zero-value games are
// unusual and CV > 0.4 is a real red flag. MLB overrides both (baseball
// has zeros in ~30% of at-bat outcomes and CV in the 0.8-1.2 range is
// normal, not a signal problem) so it doesn't self-cap below the HC bar.
const DEFAULT_VARIANCE_GUARD = {
  // If ANY value in recentStatValues is zero, cap confidence at this ceiling.
  zeroValueCap:      50,
  // If coefficient of variation exceeds this, cap confidence at cvOverThresholdCap.
  cvThreshold:       0.4,
  cvOverThresholdCap: 50,
  // Confidence ceiling when we have fewer than 20 baseline games.
  thinBaselineGames: 20,
  thinBaselineCap:   80,
};

const DEFAULT_PROFILE = {
  scoring: {
    highConfidenceThreshold: 57,
    minEdgePercentage:       15,
    confidence: {
      maxWeight:              1.4,
      strongWeight:           1.4,
      normalWeight:           1.0,
      weakWeight:             0.7,
      strongMarginCap:        2.0,
      normalMarginCap:        0.5,
      normalMarginLineFactor: 0.5,
    },
    varianceGuard: DEFAULT_VARIANCE_GUARD,
    edgeToConfidenceTiers: [
      { minAbsEdge: 20, score: 80 },
      { minAbsEdge: 12, score: 65 },
      { minAbsEdge: 6,  score: 50 },
      { minAbsEdge: 0,  score: 30 },
    ],
  },
};

const LEAGUE_PROFILES = {

  nba: {
    scoring: {
      // NBA: requires higher edge signal because RS averages don't account
      // for playoff context, minute variance, or role changes
      highConfidenceThreshold: 57,
      minEdgePercentage:       15,
      // Per-stat minimum games required before scoring
      minGamesByStatType: {
        points:         8,
        rebounds:       8,
        assists:        8,
        threes:         8,
        points_assists: 8,
        default:        8,
      },
      // NBA-specific variance guard.
      //   • Star point-scorers have CV ~0.25-0.35 (very consistent).
      //   • Role players' rebounds/assists/threes push CV to 0.4-0.7.
      //   • Zero-value games happen for role players in rebounds/assists/
      //     threes but are rare for a starter's point total.
      // The default 0.4 CV threshold would over-penalise every role-player
      // prop; 0.55 lets steady scorers pass while still flagging noise.
      varianceGuard: {
        zeroValueCap:      55,
        cvThreshold:       0.55,
        cvOverThresholdCap: 55,
        thinBaselineGames: 12,
        thinBaselineCap:   80,
      },
      confidence: {
        maxWeight:              1.4,
        strongWeight:           1.4,
        normalWeight:           1.0,
        weakWeight:             0.7,
        // Points lines are large (25+) — scale margins accordingly
        strongMarginCap:        4.0,
        normalMarginCap:        2.0,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 20, score: 80 },
        { minAbsEdge: 12, score: 65 },
        { minAbsEdge: 6,  score: 50 },
        { minAbsEdge: 0,  score: 30 },
      ],
    },
  },

  mlb: {
    scoring: {
      highConfidenceThreshold: 57,
      // Tuned per-stat based on real outcome data:
      // RBIs are most volatile (team-dependent) → higher default threshold
      // Applied via per-stat overrides below
      minEdgePercentage: 15,
      // MLB-specific variance guard — the DEFAULT caps confidence at 50 the
      // moment a stat log contains any zero OR CV > 0.4. Both are normal in
      // baseball (batter goes 0-fer ~30% of games; CV on hits/rbis/runs is
      // typically 0.8-1.2) so the default effectively pinned MLB confidence
      // at 50 for every batter → HC (threshold 57) was unreachable.
      // We relax both so HC actually fires on genuinely strong signals:
      //   • Zero-value only caps at 65 (still a soft penalty)
      //   • CV threshold raised to 1.0 before penalty applies
      varianceGuard: {
        zeroValueCap:      65,
        cvThreshold:       1.0,
        cvOverThresholdCap: 55,
        thinBaselineGames: 15,   // pitchers have thinner logs → lower minimum
        thinBaselineCap:   80,
      },
      minGamesByStatType: {
        hits:               10,
        total_bases:        10,
        runs:               10,
        rbis:               12, // needs more games — high variance
        pitcher_strikeouts: 5,  // only 5 starts needed (pitchers pitch every 5 days)
        default:            10,
      },
      // MLB props use small lines (0.5) — scale margins tightly
      confidence: {
        maxWeight:              1.4,
        strongWeight:           1.4,
        normalWeight:           1.0,
        weakWeight:             0.7,
        strongMarginCap:        1.0,  // for 0.5 lines: 1 unit margin is "strong"
        normalMarginCap:        0.3,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 30, score: 82 }, // MLB: 30%+ edge on a 0.5 line is very strong
        { minAbsEdge: 20, score: 72 },
        { minAbsEdge: 10, score: 55 },
        { minAbsEdge: 0,  score: 35 },
      ],
      // Per-stat minEdge overrides — based on real 50% win rate on total_bases
      minEdgeByStatType: {
        hits:               15,
        total_bases:        25, // weakest stat — require higher edge to qualify as bestValue
        runs:               15,
        rbis:               20, // high variance — require more edge
        pitcher_strikeouts: 8,  // tight lines, moderate edge sufficient
      },
    },
  },

  nhl: {
    scoring: {
      // NHL: shots_on_goal most consistent (~4-5/game top forwards)
      // goals/assists high variance (~0.4/game) — needs strong edge
      highConfidenceThreshold: 57,
      minEdgePercentage: 15,
      minGamesByStatType: {
        shots_on_goal: 6,
        goals:         7, // high variance — keep stricter than SOG
        assists:       7,
        points:        7,
        default:       6,
      },
      // NHL-specific variance guard.
      //   • shots_on_goal: CV ~0.4-0.7 for top forwards; zeros unusual.
      //   • goals/assists: avg 0.3-0.7 per game, CV routinely 1.0-1.5, and
      //     zero-value games occur in 60-70% of appearances even for elite
      //     scorers. The default (zeroValueCap 50, cvThreshold 0.4) makes
      //     HC unreachable for goals/assists.
      // Similar profile to MLB — tolerate goals-are-rare-events variance.
      varianceGuard: {
        zeroValueCap:      65,
        cvThreshold:       1.2,
        cvOverThresholdCap: 55,
        thinBaselineGames: 12,
        thinBaselineCap:   80,
      },
      confidence: {
        maxWeight:              1.4,
        strongWeight:           1.4,
        normalWeight:           1.0,
        weakWeight:             0.7,
        strongMarginCap:        2.0,
        normalMarginCap:        0.5,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 25, score: 80 },
        { minAbsEdge: 15, score: 65 },
        { minAbsEdge: 8,  score: 50 },
        { minAbsEdge: 0,  score: 30 },
      ],
      // shots_on_goal: most consistent NHL stat — tight threshold
      // goals: high variance (top scorers avg ~0.4-0.5/game) — need large edge
      // assists: moderate, playmakers more consistent
      // points: combined g+a, moderate variance
      minEdgeByStatType: {
        shots_on_goal: 12,
        goals:         25,
        assists:       18,
        points:        15,
      },
    },
  },

  nfl: {
    scoring: {
      highConfidenceThreshold: 57,
      minEdgePercentage: 15,
      minGamesByStatType: {
        passing_yards: 4,
        rushing_yards: 4,
        receiving_yards: 4,
        receptions: 4,
        pass_tds: 4,
        rush_reception_yards: 4,
        default: 4,
      },
      // NFL-specific variance guard.
      //   • Passing yards for a starter: CV ~0.2-0.3 (extremely consistent).
      //   • Rushing/receiving yards: CV ~0.4-0.7 (usage-driven variance).
      //   • Touchdowns: CV ~0.6-1.5; zero-TD games are the majority for RBs.
      //   • Season is only 17 games — a "thin baseline" ceiling of 20 games
      //     was mathematically impossible in NFL; capping at 6 lets the
      //     model fully trust a mid-season sample.
      varianceGuard: {
        zeroValueCap:      60,
        cvThreshold:       0.8,
        cvOverThresholdCap: 55,
        thinBaselineGames: 6,
        thinBaselineCap:   85,
      },
      confidence: {
        maxWeight:              1.4,
        strongWeight:           1.4,
        normalWeight:           1.0,
        weakWeight:             0.7,
        strongMarginCap:        12.0,
        normalMarginCap:        4.0,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 20, score: 80 },
        { minAbsEdge: 12, score: 65 },
        { minAbsEdge: 6,  score: 50 },
        { minAbsEdge: 0,  score: 30 },
      ],
      minEdgeByStatType: {
        passing_yards: 12,
        rushing_yards: 15,
        receiving_yards: 15,
        receptions: 12,
        pass_tds: 20,
        rush_reception_yards: 14,
      },
    },
  },

  soccer: {
    scoring: {
      highConfidenceThreshold: 57,
      minEdgePercentage: 15,
      minGamesByStatType: {
        goals: 5,
        assists: 5,
        shots_on_target: 5,
        default: 5,
      },
      // Soccer-specific variance guard — the MOST zero-heavy sport we cover.
      //   • Goals: avg 0.2-0.6 per game, CV 1.5-3.0. Even top scorers score
      //     in only 30-40% of appearances → 60-70% zero-value games.
      //   • Assists: nearly identical profile to goals.
      //   • Shots on target: avg 0.5-1.5, CV 0.8-1.5, zeros common.
      // Default caps would make HC unreachable for any scorer prop; we set
      // the loosest tolerances of any sport here.
      varianceGuard: {
        zeroValueCap:      70,
        cvThreshold:       1.5,
        cvOverThresholdCap: 60,
        thinBaselineGames: 5,
        thinBaselineCap:   85,
      },
      confidence: {
        maxWeight:              1.4,
        strongWeight:           1.4,
        normalWeight:           1.0,
        weakWeight:             0.7,
        strongMarginCap:        1.0,
        normalMarginCap:        0.3,
        normalMarginLineFactor: 0.5,
      },
      edgeToConfidenceTiers: [
        { minAbsEdge: 25, score: 80 },
        { minAbsEdge: 15, score: 65 },
        { minAbsEdge: 8,  score: 50 },
        { minAbsEdge: 0,  score: 30 },
      ],
      minEdgeByStatType: {
        goals: 20,
        assists: 18,
        shots_on_target: 12,
      },
    },
  },

};

/**
 * Get the league profile for a sport.
 * Falls back to DEFAULT_PROFILE if sport not found.
 */
function getLeagueProfile(sport) {
  return LEAGUE_PROFILES[sport] || DEFAULT_PROFILE;
}

/**
 * Get the minimum edge percentage for a specific stat type within a sport.
 * Falls back to the sport's global minEdgePercentage.
 */
function getMinEdgeForStat(sport, statType) {
  const profile = getLeagueProfile(sport);
  const perStat = profile.scoring?.minEdgeByStatType || {};
  return perStat[statType] ?? (profile.scoring?.minEdgePercentage ?? 15);
}

/**
 * Get the minimum games required for a specific stat type within a sport.
 */
function getMinGamesForStat(sport, statType) {
  const profile = getLeagueProfile(sport);
  const perStat = profile.scoring?.minGamesByStatType || {};
  return perStat[statType] ?? (perStat.default ?? 8);
}

module.exports = { getLeagueProfile, getMinEdgeForStat, getMinGamesForStat };


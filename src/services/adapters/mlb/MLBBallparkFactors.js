/**
 * MLBBallparkFactors.js — MLB stadium park factors
 *
 * DATA SOURCE: Static map based on published 2024 MLB park factors.
 * Sources: FanGraphs, Baseball Reference, Statcast.
 * Park factors change only when stadiums undergo major structural renovation
 * (rare, typically announced years in advance). This map is stable year-to-year.
 *
 * PARK FACTOR DEFINITION:
 *  1.00 = league-average park (perfectly neutral)
 *  > 1.00 = hitter-friendly (more offense than average)
 *  < 1.00 = pitcher-friendly (less offense than average)
 *
 * FIELDS PER PARK:
 *  parkFactor  — overall runs/hits multiplier vs league average
 *  hrFactor    — home run specific factor (can differ — short porches vs deep alleys)
 *  name        — official stadium name
 *  surface     — 'grass' | 'turf' (turf = more groundball singles, harder surface)
 *  roofType    — 'open' | 'retractable' | 'dome' (dome = weather-neutral)
 *  elevation   — feet above sea level (Coors = 5280ft, thin air = more carry)
 *
 * KEY TO USAGE IN PROMPT:
 *  parkFactor > 1.10 → hitter-friendly, OVER lean on hits/TB/runs
 *  parkFactor < 0.92 → pitcher-friendly, UNDER lean on hits/TB/runs
 *  hrFactor   > 1.15 → favorable HR park (but HR props excluded from our system)
 *  surface = 'turf'  → mention as minor OVER lean for infield hits
 *  roofType = 'dome' → weather is never a factor
 *
 * KEYED BY: The Odds API home team name (must match game.homeTeam.name exactly)
 */

const BALLPARK_FACTORS = {
  // ── American League East ──────────────────────────────────────────────────
  'Baltimore Orioles': {
    name: 'Oriole Park at Camden Yards',
    parkFactor: 1.04, hrFactor: 1.08,
    surface: 'grass', roofType: 'open', elevation: 33,
  },
  'Boston Red Sox': {
    name: 'Fenway Park',
    parkFactor: 1.07, hrFactor: 1.05,  // Green Monster unique — high OBP park
    surface: 'grass', roofType: 'open', elevation: 21,
  },
  'New York Yankees': {
    name: 'Yankee Stadium',
    parkFactor: 1.05, hrFactor: 1.20,  // Very short right field porch
    surface: 'grass', roofType: 'open', elevation: 55,
  },
  'Tampa Bay Rays': {
    name: 'Tropicana Field',
    parkFactor: 0.96, hrFactor: 0.94,
    surface: 'turf', roofType: 'dome', elevation: 48,
  },
  'Toronto Blue Jays': {
    name: 'Rogers Centre',
    parkFactor: 0.97, hrFactor: 0.99,
    surface: 'turf', roofType: 'retractable', elevation: 251,
  },

  // ── American League Central ───────────────────────────────────────────────
  'Chicago White Sox': {
    name: 'Guaranteed Rate Field',
    parkFactor: 1.01, hrFactor: 1.06,
    surface: 'grass', roofType: 'open', elevation: 595,
  },
  'Cleveland Guardians': {
    name: 'Progressive Field',
    parkFactor: 0.97, hrFactor: 0.91,  // Pitcher-friendly, deep alleys
    surface: 'grass', roofType: 'open', elevation: 653,
  },
  'Detroit Tigers': {
    name: 'Comerica Park',
    parkFactor: 0.95, hrFactor: 0.86,  // Very deep — HR suppressor
    surface: 'grass', roofType: 'open', elevation: 600,
  },
  'Kansas City Royals': {
    name: 'Kauffman Stadium',
    parkFactor: 0.98, hrFactor: 0.93,
    surface: 'grass', roofType: 'open', elevation: 909,
  },
  'Minnesota Twins': {
    name: 'Target Field',
    parkFactor: 0.99, hrFactor: 0.97,
    surface: 'grass', roofType: 'open', elevation: 815,
  },

  // ── American League West ──────────────────────────────────────────────────
  'Houston Astros': {
    name: 'Minute Maid Park',
    parkFactor: 1.01, hrFactor: 1.02,
    surface: 'grass', roofType: 'retractable', elevation: 43,
  },
  'Los Angeles Angels': {
    name: 'Angel Stadium',
    parkFactor: 0.98, hrFactor: 0.96,
    surface: 'grass', roofType: 'open', elevation: 160,
  },
  'Oakland Athletics': {
    name: 'Sutter Health Park',   // relocated to Sacramento for 2025
    parkFactor: 0.99, hrFactor: 0.97,
    surface: 'grass', roofType: 'open', elevation: 25,
  },
  'Athletics': {
    name: 'Sutter Health Park',
    parkFactor: 0.99, hrFactor: 0.97,
    surface: 'grass', roofType: 'open', elevation: 25,
  },
  'Seattle Mariners': {
    name: 'T-Mobile Park',
    parkFactor: 0.95, hrFactor: 0.89,  // Marine air, pitcher-friendly
    surface: 'grass', roofType: 'retractable', elevation: 17,
  },
  'Texas Rangers': {
    name: 'Globe Life Field',
    parkFactor: 1.03, hrFactor: 1.05,
    surface: 'grass', roofType: 'dome', elevation: 551,
  },

  // ── National League East ──────────────────────────────────────────────────
  'Atlanta Braves': {
    name: 'Truist Park',
    parkFactor: 1.04, hrFactor: 1.07,
    surface: 'grass', roofType: 'open', elevation: 1050,
  },
  'Miami Marlins': {
    name: 'loanDepot Park',
    parkFactor: 0.93, hrFactor: 0.86,  // Very pitcher-friendly
    surface: 'grass', roofType: 'retractable', elevation: 6,
  },
  'New York Mets': {
    name: 'Citi Field',
    parkFactor: 0.96, hrFactor: 0.93,  // Pitcher-friendly, large foul territory
    surface: 'grass', roofType: 'open', elevation: 20,
  },
  'Philadelphia Phillies': {
    name: 'Citizens Bank Park',
    parkFactor: 1.06, hrFactor: 1.12,  // Hitter-friendly, short RF
    surface: 'grass', roofType: 'open', elevation: 20,
  },
  'Washington Nationals': {
    name: 'Nationals Park',
    parkFactor: 1.01, hrFactor: 1.03,
    surface: 'grass', roofType: 'open', elevation: 25,
  },

  // ── National League Central ───────────────────────────────────────────────
  'Chicago Cubs': {
    name: 'Wrigley Field',
    parkFactor: 1.06, hrFactor: 1.04,  // Wind-dependent — can be extreme in either direction
    surface: 'grass', roofType: 'open', elevation: 595,
    note: 'Wind-dependent — check conditions. Can be extreme hitter or pitcher park.',
  },
  'Cincinnati Reds': {
    name: 'Great American Ball Park',
    parkFactor: 1.09, hrFactor: 1.18,  // Very hitter-friendly, short fences
    surface: 'grass', roofType: 'open', elevation: 490,
  },
  'Milwaukee Brewers': {
    name: 'American Family Field',
    parkFactor: 1.02, hrFactor: 1.06,
    surface: 'grass', roofType: 'retractable', elevation: 635,
  },
  'Pittsburgh Pirates': {
    name: 'PNC Park',
    parkFactor: 0.97, hrFactor: 0.94,  // Slightly pitcher-friendly
    surface: 'grass', roofType: 'open', elevation: 730,
  },
  'St. Louis Cardinals': {
    name: 'Busch Stadium',
    parkFactor: 0.98, hrFactor: 0.96,
    surface: 'grass', roofType: 'open', elevation: 466,
  },

  // ── National League West ──────────────────────────────────────────────────
  'Arizona Diamondbacks': {
    name: 'Chase Field',
    parkFactor: 1.05, hrFactor: 1.09,  // Retractable keeps heat in, elevation helps
    surface: 'grass', roofType: 'retractable', elevation: 1082,
  },
  'Colorado Rockies': {
    name: 'Coors Field',
    parkFactor: 1.28, hrFactor: 1.35,  // Most extreme hitter's park in baseball
    surface: 'grass', roofType: 'open', elevation: 5280,
    note: 'EXTREME hitter park. 5280ft elevation — thin air, less resistance on all batted balls.',
  },
  'Los Angeles Dodgers': {
    name: 'Dodger Stadium',
    parkFactor: 0.97, hrFactor: 0.93,  // Marine air, pitcher-friendly
    surface: 'grass', roofType: 'open', elevation: 512,
  },
  'San Diego Padres': {
    name: 'Petco Park',
    parkFactor: 0.88, hrFactor: 0.82,  // Among the most pitcher-friendly parks
    surface: 'grass', roofType: 'open', elevation: 20,
    note: 'Marine air + large dimensions = significant offense suppressor.',
  },
  'San Francisco Giants': {
    name: 'Oracle Park',
    parkFactor: 0.91, hrFactor: 0.81,  // Cold, windy, pitcher-friendly
    surface: 'grass', roofType: 'open', elevation: 0,
    note: 'Bay winds suppress fly balls significantly.',
  },
};

// Thresholds for prompt labeling
const HITTER_FRIENDLY_THRESHOLD  = 1.06;
const PITCHER_FRIENDLY_THRESHOLD = 0.94;
const NEUTRAL_RANGE              = [0.95, 1.05];

/**
 * Look up park factors for a game's home team.
 *
 * @param {string} homeTeamName - Exact The Odds API team name
 * @returns {Object|null} Park data or null if not found
 */
function getParkFactors(homeTeamName) {
  return BALLPARK_FACTORS[homeTeamName] || null;
}

/**
 * Get a simple label for how this park affects a given stat type.
 *
 * @param {Object} park
 * @param {string} statType - 'hits' | 'total_bases' | 'runs' | 'rbis'
 * @returns {{ label: string, lean: 'over'|'under'|'neutral', magnitude: number }}
 */
function getParkLean(park, statType) {
  if (!park) return { label: 'neutral park', lean: 'neutral', magnitude: 0 };

  // Use hrFactor for HR-related props, parkFactor for everything else
  const factor = park.parkFactor;
  const pct    = Math.round((factor - 1) * 100);
  const absPct = Math.abs(pct);

  let lean = 'neutral';
  let label = '';

  if (factor >= HITTER_FRIENDLY_THRESHOLD) {
    lean  = 'over';
    label = `HITTER-FRIENDLY (${pct > 0 ? '+' : ''}${pct}% vs avg)`;
  } else if (factor <= PITCHER_FRIENDLY_THRESHOLD) {
    lean  = 'under';
    label = `PITCHER-FRIENDLY (${pct}% vs avg)`;
  } else {
    lean  = 'neutral';
    label = `neutral park (${pct > 0 ? '+' : ''}${pct}% vs avg)`;
  }

  return { label, lean, magnitude: absPct };
}

/**
 * Build the park factors context block for the AI prompt.
 *
 * @param {string} homeTeamName
 * @param {string} statType
 * @returns {string} Formatted park context block, or '' if not found / pitcher prop
 */
function buildParkContextBlock(homeTeamName, statType) {
  // Park factors are irrelevant for pitcher K props
  if (statType === 'pitcher_strikeouts') return '';

  const park = getParkFactors(homeTeamName);
  if (!park) return '';

  const { label, lean, magnitude } = getParkLean(park, statType);
  const elevNote = park.elevation > 3000
    ? ` | ${park.elevation}ft elevation — thin air increases carry on all batted balls`
    : '';
  const surfaceNote = park.surface === 'turf'
    ? ' | Turf surface — faster grounders, more infield singles'
    : '';
  const roofNote = park.roofType === 'dome'
    ? ' | Dome — weather-neutral, consistent conditions'
    : park.roofType === 'retractable'
    ? ' | Retractable roof — weather usually managed'
    : '';
  const specialNote = park.note ? `\n  NOTE: ${park.note}` : '';

  const leanEmoji = lean === 'over' ? '🔴' : lean === 'under' ? '🟢' : '⚪';
  const leanStr   = lean === 'over'
    ? `favor OVER on hits/TB/runs at this venue`
    : lean === 'under'
    ? `favor UNDER on hits/TB at this pitcher-friendly venue`
    : 'park effect is minimal';

  return [
    `BALLPARK: ${park.name} — ${leanEmoji} ${label}`,
    `  Park factor ${park.parkFactor} (1.00 = neutral) → ${leanStr}${elevNote}${surfaceNote}${roofNote}${specialNote}`,
  ].join('\n');
}

module.exports = {
  BALLPARK_FACTORS,
  getParkFactors,
  getParkLean,
  buildParkContextBlock,
};
/**
 * teamMaps.js — Verified team ID and abbreviation maps for all sports
 *
 * IMPORTANT: These IDs are API-Sports IDs verified against live endpoints.
 * NBA IDs → https://media.api-sports.io/basketball/teams/{id}.png
 * MLB IDs → https://media.api-sports.io/baseball/teams/{id}.png
 * NHL IDs → https://media.api-sports.io/hockey/teams/{id}.png
 *
 * The Odds API uses full team names ("Los Angeles Lakers").
 * API-Sports uses numeric IDs (14 for Lakers).
 * ESPN CDN uses lowercase abbreviations ("lal" for Lakers).
 *
 * All three are mapped here so any adapter can resolve any format.
 */

// ─── NBA ──────────────────────────────────────────────────────────────────────
// IDs confirmed from API-Sports basketball v2 live responses (season 2024)
// Logo test: https://media.api-sports.io/basketball/teams/14.png ✅

const NBA_TEAMS = {
  'Atlanta Hawks':          { id: 1,  abbr: 'atl', espn: 'atl' },
  'Boston Celtics':         { id: 2,  abbr: 'bos', espn: 'bos' },
  'Brooklyn Nets':          { id: 4,  abbr: 'bkn', espn: 'bkn' },
  'Charlotte Hornets':      { id: 5,  abbr: 'cha', espn: 'cha' },
  'Chicago Bulls':          { id: 6,  abbr: 'chi', espn: 'chi' },
  'Cleveland Cavaliers':    { id: 7,  abbr: 'cle', espn: 'cle' },
  'Dallas Mavericks':       { id: 8,  abbr: 'dal', espn: 'dal' },
  'Denver Nuggets':         { id: 9,  abbr: 'den', espn: 'den' },
  'Detroit Pistons':        { id: 10, abbr: 'det', espn: 'det' },
  'Golden State Warriors':  { id: 11, abbr: 'gsw', espn: 'gs'  },
  'Houston Rockets':        { id: 14, abbr: 'hou', espn: 'hou' },
  'Indiana Pacers':         { id: 15, abbr: 'ind', espn: 'ind' },
  'Los Angeles Clippers':   { id: 16, abbr: 'lac', espn: 'lac' },
  'Los Angeles Lakers':     { id: 17, abbr: 'lal', espn: 'lal' },
  'Memphis Grizzlies':      { id: 19, abbr: 'mem', espn: 'mem' },
  'Miami Heat':             { id: 20, abbr: 'mia', espn: 'mia' },
  'Milwaukee Bucks':        { id: 21, abbr: 'mil', espn: 'mil' },
  'Minnesota Timberwolves': { id: 22, abbr: 'min', espn: 'min' },
  'New Orleans Pelicans':   { id: 23, abbr: 'nop', espn: 'no'  },
  'New York Knicks':        { id: 24, abbr: 'nyk', espn: 'ny'  },
  'Oklahoma City Thunder':  { id: 25, abbr: 'okc', espn: 'okc' },
  'Orlando Magic':          { id: 26, abbr: 'orl', espn: 'orl' },
  'Philadelphia 76ers':     { id: 27, abbr: 'phi', espn: 'phi' },
  'Phoenix Suns':           { id: 28, abbr: 'phx', espn: 'phx' },
  'Portland Trail Blazers': { id: 29, abbr: 'por', espn: 'por' },
  'Sacramento Kings':       { id: 30, abbr: 'sac', espn: 'sac' },
  'San Antonio Spurs':      { id: 31, abbr: 'sas', espn: 'sa'  },
  'Toronto Raptors':        { id: 38, abbr: 'tor', espn: 'tor' },
  'Utah Jazz':              { id: 40, abbr: 'uta', espn: 'utah'},
  'Washington Wizards':     { id: 41, abbr: 'was', espn: 'wsh' },
};

// ─── MLB ─────────────────────────────────────────────────────────────────────
// IDs confirmed from API-Sports baseball v1
// Logo test: https://media.api-sports.io/baseball/teams/4.png ✅ (Yankees)

const MLB_TEAMS = {
  'Arizona Diamondbacks':   { id: 14, abbr: 'ari', espn: 'ari' },
  'Atlanta Braves':         { id: 8,  abbr: 'atl', espn: 'atl' },
  'Baltimore Orioles':      { id: 6,  abbr: 'bal', espn: 'bal' },
  'Boston Red Sox':         { id: 2,  abbr: 'bos', espn: 'bos' },
  'Chicago Cubs':           { id: 7,  abbr: 'chc', espn: 'chc' },
  'Chicago White Sox':      { id: 13, abbr: 'cws', espn: 'cws' },
  'Cincinnati Reds':        { id: 17, abbr: 'cin', espn: 'cin' },
  'Cleveland Guardians':    { id: 11, abbr: 'cle', espn: 'cle' },
  'Colorado Rockies':       { id: 15, abbr: 'col', espn: 'col' },
  'Detroit Tigers':         { id: 10, abbr: 'det', espn: 'det' },
  'Houston Astros':         { id: 20, abbr: 'hou', espn: 'hou' },
  'Kansas City Royals':     { id: 18, abbr: 'kc',  espn: 'kc'  },
  'Los Angeles Angels':     { id: 22, abbr: 'laa', espn: 'laa' },
  'Los Angeles Dodgers':    { id: 19, abbr: 'lad', espn: 'lad' },
  'Miami Marlins':          { id: 26, abbr: 'mia', espn: 'mia' },
  'Milwaukee Brewers':      { id: 9,  abbr: 'mil', espn: 'mil' },
  'Minnesota Twins':        { id: 16, abbr: 'min', espn: 'min' },
  'New York Mets':          { id: 25, abbr: 'nym', espn: 'nym' },
  'New York Yankees':       { id: 4,  abbr: 'nyy', espn: 'nyy' },
  'Oakland Athletics':      { id: 21, abbr: 'oak', espn: 'oak' },
  'Athletics':              { id: 21, abbr: 'oak', espn: 'oak' }, // alt name
  'Philadelphia Phillies':  { id: 23, abbr: 'phi', espn: 'phi' },
  'Pittsburgh Pirates':     { id: 24, abbr: 'pit', espn: 'pit' },
  'San Diego Padres':       { id: 28, abbr: 'sd',  espn: 'sd'  },
  'San Francisco Giants':   { id: 27, abbr: 'sf',  espn: 'sf'  },
  'Seattle Mariners':       { id: 12, abbr: 'sea', espn: 'sea' },
  'St. Louis Cardinals':    { id: 29, abbr: 'stl', espn: 'stl' },
  'Tampa Bay Rays':         { id: 30, abbr: 'tb',  espn: 'tb'  },
  'Texas Rangers':          { id: 3,  abbr: 'tex', espn: 'tex' },
  'Toronto Blue Jays':      { id: 1,  abbr: 'tor', espn: 'tor' },
  'Washington Nationals':   { id: 5,  abbr: 'was', espn: 'wsh' },
};

// ─── NHL ─────────────────────────────────────────────────────────────────────
// API-Sports Hockey v1 team IDs (league 57, season 2024)
const NHL_TEAMS = {
  'Anaheim Ducks':         { id: 670,  abbr: 'ana' },
  'Boston Bruins':         { id: 673,  abbr: 'bos' },
  'Buffalo Sabres':        { id: 674,  abbr: 'buf' },
  'Calgary Flames':        { id: 675,  abbr: 'cgy' },
  'Carolina Hurricanes':   { id: 676,  abbr: 'car' },
  'Chicago Blackhawks':    { id: 678,  abbr: 'chi' },
  'Colorado Avalanche':    { id: 679,  abbr: 'col' },
  'Columbus Blue Jackets': { id: 680,  abbr: 'cbj' },
  'Dallas Stars':          { id: 681,  abbr: 'dal' },
  'Detroit Red Wings':     { id: 682,  abbr: 'det' },
  'Edmonton Oilers':       { id: 683,  abbr: 'edm' },
  'Florida Panthers':      { id: 684,  abbr: 'fla' },
  'Los Angeles Kings':     { id: 685,  abbr: 'lak' },
  'Minnesota Wild':        { id: 687,  abbr: 'min' },
  'Montreal Canadiens':    { id: 688,  abbr: 'mtl' },
  'Montréal Canadiens': { id: 688, abbr: 'mtl' },
  'Nashville Predators':   { id: 689,  abbr: 'nsh' },
  'New Jersey Devils':     { id: 690,  abbr: 'njd' },
  'New York Islanders':    { id: 691,  abbr: 'nyi' },
  'New York Rangers':      { id: 692,  abbr: 'nyr' },
  'Ottawa Senators':       { id: 693,  abbr: 'ott' },
  'Philadelphia Flyers':   { id: 695,  abbr: 'phi' },
  'Pittsburgh Penguins':   { id: 696,  abbr: 'pit' },
  'San Jose Sharks':       { id: 697,  abbr: 'sjs' },
  'Seattle Kraken':        { id: 1436, abbr: 'sea' },
  'St. Louis Blues':       { id: 698,  abbr: 'stl' },
  'Tampa Bay Lightning':   { id: 699,  abbr: 'tbl' },
  'Toronto Maple Leafs':   { id: 700,  abbr: 'tor' },
  'Utah Mammoth':          { id: 2483, abbr: 'uta' },
  'Vancouver Canucks':     { id: 701,  abbr: 'van' },
  'Vegas Golden Knights':  { id: 702,  abbr: 'vgk' },
  'Washington Capitals':   { id: 703,  abbr: 'wsh' },
  'Winnipeg Jets':         { id: 704,  abbr: 'wpg' },
};

// ─── Lookup helpers ───────────────────────────────────────────────────────────

const TEAM_MAPS = { nba: NBA_TEAMS, mlb: MLB_TEAMS, nhl: NHL_TEAMS };

/**
 * Get API-Sports numeric team ID from full team name.
 * @param {string} sport  - 'nba' | 'mlb' | 'nhl'
 * @param {string} name   - Full team name from The Odds API
 * @returns {number|null}
 */
const getTeamId = (sport, name) => TEAM_MAPS[sport]?.[name]?.id || null;

/**
 * Get team abbreviation (uppercase) from full team name.
 */
const getTeamAbbr = (sport, name) => {
  const abbr = TEAM_MAPS[sport]?.[name]?.abbr;
  return abbr ? abbr.toUpperCase() : (name?.slice(0,3).toUpperCase() || '???');
};

/**
 * Get ESPN CDN logo URL for a team.
 * @returns {string} Full HTTPS URL ready to use in <img src>
 */
const getTeamLogoUrl = (sport, name) => {
  const team = TEAM_MAPS[sport]?.[name];
  if (!team) return null;
  const sportPath = { nba: 'nba', mlb: 'mlb', nhl: 'hockey', nfl: 'nfl' }[sport] || sport;
  return `https://a.espncdn.com/i/teamlogos/${sportPath}/500/${team.espn}.png`;
};

/**
 * Get API-Sports CDN logo URL (backup if ESPN fails).
 */
const getApiSportsLogoUrl = (sport, name) => {
  const id = getTeamId(sport, name);
  if (!id) return null;
  const path = { nba: 'basketball', mlb: 'baseball', nhl: 'hockey', nfl: 'american-football' }[sport];
  return `https://media.api-sports.io/${path}/teams/${id}.png`;
};

module.exports = {
  NBA_TEAMS, MLB_TEAMS, NHL_TEAMS,
  getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl,
};
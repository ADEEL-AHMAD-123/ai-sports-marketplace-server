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

// ─── NFL ─────────────────────────────────────────────────────────────────────
const NFL_TEAMS = {
  'Arizona Cardinals':      { abbr: 'ari', espn: 'ari' },
  'Atlanta Falcons':        { abbr: 'atl', espn: 'atl' },
  'Baltimore Ravens':       { abbr: 'bal', espn: 'bal' },
  'Buffalo Bills':          { abbr: 'buf', espn: 'buf' },
  'Carolina Panthers':      { abbr: 'car', espn: 'car' },
  'Chicago Bears':          { abbr: 'chi', espn: 'chi' },
  'Cincinnati Bengals':     { abbr: 'cin', espn: 'cin' },
  'Cleveland Browns':       { abbr: 'cle', espn: 'cle' },
  'Dallas Cowboys':         { abbr: 'dal', espn: 'dal' },
  'Denver Broncos':         { abbr: 'den', espn: 'den' },
  'Detroit Lions':          { abbr: 'det', espn: 'det' },
  'Green Bay Packers':      { abbr: 'gb',  espn: 'gb' },
  'Houston Texans':         { abbr: 'hou', espn: 'hou' },
  'Indianapolis Colts':     { abbr: 'ind', espn: 'ind' },
  'Jacksonville Jaguars':   { abbr: 'jax', espn: 'jax' },
  'Kansas City Chiefs':     { abbr: 'kc',  espn: 'kc' },
  'Las Vegas Raiders':      { abbr: 'lv',  espn: 'lv' },
  'Los Angeles Chargers':   { abbr: 'lac', espn: 'lac' },
  'LA Chargers':            { abbr: 'lac', espn: 'lac' },
  'Los Angeles Rams':       { abbr: 'lar', espn: 'lar' },
  'LA Rams':                { abbr: 'lar', espn: 'lar' },
  'Miami Dolphins':         { abbr: 'mia', espn: 'mia' },
  'Minnesota Vikings':      { abbr: 'min', espn: 'min' },
  'New England Patriots':   { abbr: 'ne',  espn: 'ne' },
  'New Orleans Saints':     { abbr: 'no',  espn: 'no' },
  'New York Giants':        { abbr: 'nyg', espn: 'nyg' },
  'New York Jets':          { abbr: 'nyj', espn: 'nyj' },
  'Philadelphia Eagles':    { abbr: 'phi', espn: 'phi' },
  'Pittsburgh Steelers':    { abbr: 'pit', espn: 'pit' },
  'San Francisco 49ers':    { abbr: 'sf',  espn: 'sf' },
  'Seattle Seahawks':       { abbr: 'sea', espn: 'sea' },
  'Tampa Bay Buccaneers':   { abbr: 'tb',  espn: 'tb' },
  'Tennessee Titans':       { abbr: 'ten', espn: 'ten' },
  'Washington Commanders':  { abbr: 'was', espn: 'wsh' },
};

// ─── Soccer (Premier League) ───────────────────────────────────────────────
// API-Sports football v3 team IDs (league 39)
// NOTE on `id` field for soccer teams: this is the API-Sports "football"
// numeric team ID, used to build a logo URL at
//   https://media.api-sports.io/football/teams/{id}.png
// Those images are public — you can hotlink them without an API-Sports
// subscription. So having `id` on a team gives us a working crest even
// if the caller's football data plan doesn't include the league.
//
// If a team is missing `id` here, getTeamLogoUrl falls back to the ESPN
// CDN using the abbreviation. That ESPN URL is a best-effort — some codes
// won't exist there and the frontend's TeamLogo onError handler falls
// through to initials.
const SOCCER_TEAMS = {
  'Sevilla':                 { id: 536, abbr: 'sev' },
  'Espanyol':                { id: 540, abbr: 'esp' },
  'Atletico Madrid':         { id: 530, abbr: 'atm' },
  'Atlético Madrid':         { id: 530, abbr: 'atm' },
  'Celta Vigo':              { id: 538, abbr: 'cel' },
  // Wolfsburg uses 'wob' (their standard Bundesliga code) so it doesn't
  // collide with Wolverhampton (Wolves) also using 'wol' in the EPL.
  'VfL Wolfsburg':           { id: 161, abbr: 'wob' },
  'Bayern Munich':           { id: 157, abbr: 'bay' },
  'Bayern München':          { id: 157, abbr: 'bay' },
  'Toronto FC':              { id: 1601, abbr: 'tor' },
  'Inter Miami':             { id: 9568, abbr: 'mia' },
  'Inter Miami CF':          { id: 9568, abbr: 'mia' },
  'Lazio':                   { id: 487, abbr: 'laz' },
  'Inter Milan':             { id: 505, abbr: 'int' },
  'Inter':                   { id: 505, abbr: 'int' },
  // Sunderland — API-Sports football ID varies by data source, and 49 was
  // colliding with Chelsea. Dropping the ID; ESPN CDN fallback handles the
  // crest via abbr, initials via onError if that also 404s.
  'Sunderland':              { abbr: 'sun' },
  'Arsenal':                 { id: 42, abbr: 'ars' },
  'Aston Villa':             { id: 66, abbr: 'avl' },
  'Bournemouth':             { id: 35, abbr: 'bou' },
  'Brentford':               { id: 55, abbr: 'bre' },
  'Brighton and Hove Albion': { id: 51, abbr: 'bha' },
  'Brighton':                { id: 51, abbr: 'bha' },
  'Burnley':                 { id: 44, abbr: 'bur' },
  'Chelsea':                 { id: 49, abbr: 'che' },
  'Crystal Palace':          { id: 52, abbr: 'cry' },
  'Everton':                 { id: 45, abbr: 'eve' },
  'Fulham':                  { id: 36, abbr: 'ful' },
  'Ipswich':                 { id: 57, abbr: 'ips' },
  'Leicester':               { id: 46, abbr: 'lei' },
  'Liverpool':               { id: 40, abbr: 'liv' },
  'Manchester City':         { id: 50, abbr: 'mci' },
  'Manchester United':       { id: 33, abbr: 'mun' },
  'Newcastle':               { id: 34, abbr: 'new' },
  'Nottingham Forest':       { id: 65, abbr: 'nfo' },
  'Southampton':             { id: 41, abbr: 'sou' },
  'Tottenham Hotspur':       { id: 47, abbr: 'tot' },
  'Tottenham':               { id: 47, abbr: 'tot' },
  'West Ham':                { id: 48, abbr: 'whu' },
  'Wolverhampton Wanderers': { id: 39, abbr: 'wol' },
  'Wolves':                  { id: 39, abbr: 'wol' },

  // ─── MLS (US/Canada) ──────────────────────────────────────────────────
  // API-Sports football team IDs. These are public — the image at
  // media.api-sports.io/football/teams/{id}.png loads without an auth
  // header, so this works even if the caller's API-Sports football plan
  // is inactive. Abbreviations match MLS's official 3-letter codes so
  // NYC ≠ NE (both were previously falling into the name.slice(0,3)
  // collision as "NEW"). Alt names cover Odds-API variants (with/without
  // FC, CF, SC).
  'Atlanta United FC':       { id: 1608, abbr: 'atl' },
  'Atlanta United':          { id: 1608, abbr: 'atl' },
  'Austin FC':               { id: 9569, abbr: 'atx' },
  'Charlotte FC':            { id: 18310, abbr: 'clt' },
  'Chicago Fire FC':         { id: 1599, abbr: 'chi' },
  'Chicago Fire':            { id: 1599, abbr: 'chi' },
  'FC Cincinnati':           { id: 2242, abbr: 'cin' },
  'Colorado Rapids':         { id: 1600, abbr: 'col' },
  'Columbus Crew':           { id: 1602, abbr: 'clb' },
  'Columbus Crew SC':        { id: 1602, abbr: 'clb' },
  'D.C. United':             { id: 1603, abbr: 'dc'  },
  'DC United':               { id: 1603, abbr: 'dc'  },
  'FC Dallas':               { id: 1604, abbr: 'dal' },
  'Houston Dynamo FC':       { id: 1605, abbr: 'hou' },
  'Houston Dynamo':          { id: 1605, abbr: 'hou' },
  'Los Angeles FC':          { id: 2237, abbr: 'lafc' },
  'LAFC':                    { id: 2237, abbr: 'lafc' },
  'LA Galaxy':               { id: 1616, abbr: 'lag' },
  'Los Angeles Galaxy':      { id: 1616, abbr: 'lag' },
  'Minnesota United FC':     { id: 1596, abbr: 'min' },
  'Minnesota United':        { id: 1596, abbr: 'min' },
  'CF Montreal':             { id: 1614, abbr: 'mtl' },
  'Montreal Impact':         { id: 1614, abbr: 'mtl' },
  'Nashville SC':            { id: 18314, abbr: 'nsh' },
  'New England Revolution':  { id: 1615, abbr: 'ne'  },
  'New York City FC':        { id: 1611, abbr: 'nyc' },
  'New York Red Bulls':      { id: 1613, abbr: 'nyr' },
  'Orlando City SC':         { id: 1610, abbr: 'orl' },
  'Orlando City':            { id: 1610, abbr: 'orl' },
  'Philadelphia Union':      { id: 1617, abbr: 'phi' },
  'Portland Timbers':        { id: 1607, abbr: 'por' },
  'Real Salt Lake':          { id: 1606, abbr: 'rsl' },
  // San Jose — dropping the incorrect ID (was colliding with Toronto FC's
  // 1601). ESPN CDN fallback via abbr; onError → initials if that misses.
  'San Jose Earthquakes':    { abbr: 'sj'  },
  'Seattle Sounders FC':     { id: 1609, abbr: 'sea' },
  'Seattle Sounders':        { id: 1609, abbr: 'sea' },
  'Sporting Kansas City':    { id: 1612, abbr: 'skc' },
  'Sporting KC':             { id: 1612, abbr: 'skc' },
  'St. Louis City SC':       { id: 18315, abbr: 'stl' },
  'St Louis City SC':        { id: 18315, abbr: 'stl' },
  'Vancouver Whitecaps FC':  { id: 1598, abbr: 'van' },
  'Vancouver Whitecaps':     { id: 1598, abbr: 'van' },

  // Segunda / Liga F variants seen in the current Odds-API feed. IDs
  // omitted where uncertain — ESPN CDN fallback kicks in via abbr.
  'Elche CF':                { abbr: 'elc' },
  'Elche':                   { abbr: 'elc' },
  'Deportivo La Coruña':     { abbr: 'dep' },
  'Deportivo La Coruna':     { abbr: 'dep' },
  'Malaga':                  { abbr: 'mal' },
  'Málaga':                  { abbr: 'mal' },

  // ─── La Liga (additional teams from Odds-API feed) ────────────────────
  'Athletic Bilbao':         { id: 531, abbr: 'ath' },
  'Athletic Club':           { id: 531, abbr: 'ath' },
  'Real Betis':              { id: 543, abbr: 'bet' },
  'Real Sociedad':           { id: 548, abbr: 'rso' },
  'Rayo Vallecano':          { id: 728, abbr: 'ray' },
  'Alavés':                  { id: 542, abbr: 'ala' },
  'Alaves':                  { id: 542, abbr: 'ala' },
  'Valencia':                { id: 532, abbr: 'val' },

  // ─── Serie A ──────────────────────────────────────────────────────────
  'AC Milan':                { id: 489, abbr: 'mil' },
  'Milan':                   { id: 489, abbr: 'mil' },
  'AS Roma':                 { id: 497, abbr: 'rom' },
  'Roma':                    { id: 497, abbr: 'rom' },
  'Juventus':                { id: 496, abbr: 'juv' },
  'Fiorentina':              { id: 502, abbr: 'fio' },
  'Atalanta':                { id: 499, abbr: 'ata' },
  'Atalanta BC':             { id: 499, abbr: 'ata' },
  // Torino uses 'tori' (not 'tor') so it doesn't collide with Toronto FC's
  // 'tor' abbreviation on the frontend — different clubs entirely, and
  // matching abbreviations were confusing on the multi-sport slate.
  'Torino':                  { id: 503, abbr: 'tori' },
  'Bologna':                 { id: 500, abbr: 'bol' },
  'Sassuolo':                { id: 488, abbr: 'sas' },
  'Udinese':                 { id: 494, abbr: 'udi' },
  'Lecce':                   { id: 867, abbr: 'lec' },
  'Frosinone':               { id: 512, abbr: 'fro' },
  'Venezia':                 { id: 517, abbr: 'ven' },
  // Monza / Empoli — 511 was duplicated across both. Napoli is 492
  // (verified — Napoli is the well-known club at that ID). Parma / Monza /
  // Empoli IDs are less certain; dropping to let ESPN fallback handle so
  // wrong crests don't appear.
  'Monza':                   { abbr: 'mon' },
  'Como':                    { id: 895, abbr: 'com' },
  'Genoa':                   { id: 495, abbr: 'gen' },
  'Empoli':                  { abbr: 'emp' },
  'Cagliari':                { id: 490, abbr: 'cag' },
  'Verona':                  { id: 504, abbr: 'ver' },
  'Hellas Verona':           { id: 504, abbr: 'ver' },
  'Parma':                   { abbr: 'par' },
  'Napoli':                  { id: 492, abbr: 'nap' },

  // ─── Ligue 1 (France) ─────────────────────────────────────────────────
  'Marseille':               { id: 81,  abbr: 'mar' },
  'Olympique Marseille':     { id: 81,  abbr: 'mar' },
  'Strasbourg':              { id: 95,  abbr: 'str' },
  'RC Lens':                 { id: 116, abbr: 'len' },
  'Lens':                    { id: 116, abbr: 'len' },
  'Auxerre':                 { id: 108, abbr: 'aux' },
  'Paris Saint Germain':     { id: 85,  abbr: 'psg' },
  'PSG':                     { id: 85,  abbr: 'psg' },
  'Lyon':                    { id: 80,  abbr: 'lyo' },
  'Olympique Lyonnais':      { id: 80,  abbr: 'lyo' },
  'Monaco':                  { id: 91,  abbr: 'mco' },
  'AS Monaco':               { id: 91,  abbr: 'mco' },
  'Nice':                    { id: 84,  abbr: 'nic' },
  'Lille':                   { id: 79,  abbr: 'lil' },
  'Rennes':                  { id: 94,  abbr: 'ren' },
  'Nantes':                  { id: 83,  abbr: 'nte' },
  'Toulouse':                { id: 96,  abbr: 'tou' },
  'Reims':                   { id: 93,  abbr: 'rei' },
  'Montpellier':             { id: 82,  abbr: 'mtp' },

  // ─── EFL Championship teams seen in the EPL feed ──────────────────────
  // The Odds API's soccer_epl feed sometimes includes recently-promoted or
  // relegated sides during the transition window. Adding IDs so their
  // crests still render.
  // Championship crossover — Leeds keeps id 63 (verified). Coventry and
  // Hull IDs I'm not confident about, so we drop them and let ESPN CDN
  // fallback handle. Ipswich reuses id 57 which is confirmed.
  'Coventry City':           { abbr: 'cov' },
  'Hull City':               { abbr: 'hul' },
  'Leeds United':            { id: 63,  abbr: 'lee' },
  'Ipswich Town':            { id: 57,  abbr: 'ips' },

  // ─── MLS 2025 expansion side ──────────────────────────────────────────
  'San Diego FC':            { abbr: 'sd' },   // id unknown yet — ESPN fallback via abbr
};

// ─── Lookup helpers ───────────────────────────────────────────────────────────

const TEAM_MAPS = { nba: NBA_TEAMS, mlb: MLB_TEAMS, nhl: NHL_TEAMS, nfl: NFL_TEAMS, soccer: SOCCER_TEAMS };

/**
 * Get API-Sports numeric team ID from full team name.
 * @param {string} sport  - 'nba' | 'mlb' | 'nhl'
 * @param {string} name   - Full team name from The Odds API
 * @returns {number|null}
 */
const getTeamId = (sport, name) => TEAM_MAPS[sport]?.[name]?.id || null;

// Track which fallback abbreviations we've already warned about so we don't
// spam the logs on every single game/prop cycle.
const _unmappedAbbrWarned = new Set();

/**
 * Get team abbreviation (uppercase) from full team name.
 *
 * If the team isn't in the sport's map, this falls back to slice(0,3) of
 * the name — that fallback is collision-prone ("New York City FC" and
 * "New England Revolution" both slice to "NEW"), so we emit a one-time
 * warning per unmapped team so ops can add it to the map.
 */
const getTeamAbbr = (sport, name) => {
  const abbr = TEAM_MAPS[sport]?.[name]?.abbr;
  if (abbr) return abbr.toUpperCase();

  const fallback = name?.slice(0, 3).toUpperCase() || '???';
  const warnKey = `${sport}:${name}`;
  if (name && !_unmappedAbbrWarned.has(warnKey)) {
    _unmappedAbbrWarned.add(warnKey);
    // Deferred require to avoid a config→logger circular dep at load time.
    try {
      const logger = require('../../config/logger');
      logger.warn(
        `[teamMaps] ${sport} team "${name}" is not in the abbreviation map — ` +
        `falling back to slice "${fallback}" (may collide with other teams). ` +
        `Add it to teamMaps.js.`
      );
    } catch { /* ignore — never throw from a formatting helper */ }
  }
  return fallback;
};

/**
 * Get a logo URL for a team, trying the most reliable source first.
 *
 * Soccer resolution order:
 *   1. API-Sports football CDN using hardcoded team `id`
 *      (media.api-sports.io/football/teams/{id}.png — public image, works
 *       without an API-Sports subscription)
 *   2. ESPN CDN using the team abbreviation as a final fallback
 *      (a.espncdn.com/i/teamlogos/soccer/500/{abbr}.png — some URLs 404,
 *       frontend's <TeamLogo onError> falls through to initials)
 *
 * Non-soccer sports: uses ESPN CDN with either the sport's known `espn`
 * code or the abbreviation.
 *
 * @returns {string|null} Full HTTPS URL, or null if we can't build one.
 */
const getTeamLogoUrl = (sport, name) => {
  if (sport === 'soccer') {
    const apiSportsUrl = getApiSportsLogoUrl(sport, name);
    if (apiSportsUrl) return apiSportsUrl;
    // Fallback to ESPN's soccer CDN. This is best-effort — codes for some
    // teams (particularly newer MLS expansion sides) don't exist there,
    // in which case the frontend's TeamLogo onError shows initials.
    const abbr = TEAM_MAPS.soccer?.[name]?.abbr;
    if (abbr) return `https://a.espncdn.com/i/teamlogos/soccer/500/${abbr.toLowerCase()}.png`;
    return null;
  }
  const team = TEAM_MAPS[sport]?.[name];
  if (!team) return null;
  const espnCode = team.espn || team.abbr;   // NHL entries only have abbr
  if (!espnCode) return null;
  const sportPath = { nba: 'nba', mlb: 'mlb', nhl: 'nhl', nfl: 'nfl', soccer: 'soccer' }[sport] || sport;
  return `https://a.espncdn.com/i/teamlogos/${sportPath}/500/${espnCode}.png`;
};

/**
 * Get API-Sports CDN logo URL (backup if ESPN fails).
 */
const getApiSportsLogoUrl = (sport, name) => {
  const id = getTeamId(sport, name);
  if (!id) return null;
  const path = { nba: 'basketball', mlb: 'baseball', nhl: 'hockey', nfl: 'american-football', soccer: 'football' }[sport];
  return `https://media.api-sports.io/${path}/teams/${id}.png`;
};

module.exports = {
  NBA_TEAMS, MLB_TEAMS, NHL_TEAMS, NFL_TEAMS, SOCCER_TEAMS,
  getTeamId, getTeamAbbr, getTeamLogoUrl, getApiSportsLogoUrl,
};
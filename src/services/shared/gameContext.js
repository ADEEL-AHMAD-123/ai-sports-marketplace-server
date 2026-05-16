/**
 * gameContext.js — Game context detection utilities
 *
 * Detects playoff vs regular season games and builds context strings
 * for the AI prompt. This was the #1 miss factor in accuracy testing:
 *   - Desmond Bane 7 threes: playoff usage spike, RS avg was 1.9
 *   - Wendell Carter Jr 17 reb: playoff role expansion, RS avg was 6.4
 *
 * DETECTION METHODS (in priority order):
 *  1. The Odds API event title contains "Playoff" or "NBA Playoffs"
 *  2. Date-based: NBA playoffs run mid-April through June
 *  3. Game number context from title (e.g. "Game 3")
 *
 * NBA PLAYOFF SCHEDULE (approximate, adjusts yearly):
 *  Regular Season: October → mid-April
 *  Play-In:        mid-April (2 weeks)
 *  Playoffs:       mid-April → June
 *  Finals:         May → June
 *
 * WHY THIS MATTERS FOR ACCURACY:
 *  In playoffs, stars play more minutes, usage spikes for key players,
 *  role players get reduced/eliminated, and matchup-specific schemes
 *  can dramatically shift performance from RS averages.
 *  The AI must know this to weight form vs baseline correctly.
 */

const NBA_PLAYOFF_START_MONTH = 3;  // April = month index 3 (0-based)
const NBA_PLAYOFF_END_MONTH   = 5;  // June = month index 5
const NBA_PLAYOFF_START_DAY_IN_APRIL = 15;

/**
 * Detect if an NBA game is a playoff game.
 *
 * @param {Object} game - Normalized game document from MongoDB
 *   game.oddsEventId, game.startTime, game.homeTeam, game.awayTeam
 *   Optional: game.eventTitle (from The Odds API raw response)
 * @returns {{ isPlayoff: boolean, gameNumber: number|null, round: string|null, seriesContext: string }}
 */
function detectNBAGameContext(game) {
  if (!game) return _buildContext(false, null, null);

  const startTime = game.startTime ? new Date(game.startTime) : null;
  const month     = startTime ? startTime.getUTCMonth() : null; // 0-based
  const day       = startTime ? startTime.getUTCDate() : null;

  // Method 1: explicit provider marker (most reliable)
  if (game.isPlayoff === true) {
    const title = game.eventTitle || game.title || '';
    const gameNum = _extractGameNumber(title);
    const round = game.playoffRound || _extractRound(title);
    return _buildContext(true, gameNum, round);
  }

  if (game.isPlayoff === false) {
    return _buildContext(false, null, null);
  }

  // Method 2: Title contains explicit playoff indicator
  const title = game.eventTitle || game.title || '';
  const isPlayoffByTitle = /playoff|play.?off|nba finals|conference final|conference semi|first round/i.test(title);

  if (isPlayoffByTitle) {
    const gameNum = _extractGameNumber(title);
    const round   = _extractRound(title);
    return _buildContext(true, gameNum, round);
  }

  // Method 3: Date-based fallback (strict)
  // Guardrail: avoid misclassifying early-April regular season games.
  const isPlayoffByDate = month !== null
    && month >= NBA_PLAYOFF_START_MONTH
    && month <= NBA_PLAYOFF_END_MONTH
    && (
      month > NBA_PLAYOFF_START_MONTH
      || (day !== null && day >= NBA_PLAYOFF_START_DAY_IN_APRIL)
    );

  if (isPlayoffByDate) {
    // Could be play-in (early April) or full playoffs — treat same way
    // Play-in games are also high-stakes with similar usage patterns
    const gameNum = _extractGameNumber(title);
    const round   = _extractRound(title);
    return _buildContext(true, gameNum, round);
  }

  return _buildContext(false, null, null);
}

function _extractGameNumber(title) {
  const match = title.match(/game\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function _extractRound(title) {
  if (/finals?/i.test(title) && !/conference/i.test(title)) return 'NBA Finals';
  if (/conference\s*finals?/i.test(title)) return 'Conference Finals';
  if (/conference\s*semi/i.test(title)) return 'Conference Semifinals';
  if (/first\s*round|round\s*1|opening\s*round/i.test(title)) return 'First Round';
  return 'Playoffs';
}

function _buildContext(isPlayoff, gameNumber, round) {
  let seriesContext = '';
  if (isPlayoff) {
    const roundStr = round || 'Playoffs';
    const gameStr  = gameNumber ? ` (Game ${gameNumber})` : '';
    seriesContext  = `${roundStr}${gameStr}`;
  }
  return { isPlayoff, gameNumber, round, seriesContext };
}

/**
 * Build the playoff context string for injection into the AI prompt.
 *
 * @param {Object} gameCtx - Output of detectNBAGameContext()
 * @param {Object} opts
 * @param {string} opts.sport - 'nba' | 'mlb'
 * @returns {string} Context block to add to prompt, or '' for regular season
 */
function buildGameContextPromptBlock(gameCtx, opts = {}) {
  if (!gameCtx?.isPlayoff) return '';

  const lines = [
    `⚠️ PLAYOFF CONTEXT: ${gameCtx.seriesContext}`,
    'Key differences from regular season stats:',
    '  - Star players: higher usage rate, more minutes (may OVER perform RS avg)',
    '  - Role players: reduced or eliminated role (may UNDER perform RS avg)',
    '  - 3-point shooting: more variance due to defensive adjustments',
    '  - Rebounds: matchup-specific schemes can spike rebounding for mismatches',
    'Weight FORM window heavily — recent playoff games > full RS baseline.',
    'If form avg differs from baseline by >20%, trust the form.',
  ];

  if (gameCtx.gameNumber && gameCtx.gameNumber >= 3) {
    lines.push(`Series fatigue factor: Game ${gameCtx.gameNumber} — minutes load may shift.`);
  }

  return lines.join('\n');
}

/**
 * Detect MLB game context (day/night, series context, etc.)
 * Simpler than NBA — no playoffs in same way, but day games affect offense.
 *
 * @param {Object} game
 * @returns {{ isDayGame: boolean, contextStr: string }}
 */
function detectMLBGameContext(game) {
  if (!game) return { isDayGame: false, contextStr: '' };

  const startTime = game.startTime ? new Date(game.startTime) : null;
  if (!startTime) return { isDayGame: false, contextStr: '' };

  // Day game: before 5 PM local (approximate — startTime is UTC)
  // Most day games start at 1-4 PM ET = 17:00-20:00 UTC
  const utcHour    = startTime.getUTCHours();
  const isDayGame  = utcHour >= 15 && utcHour < 20; // ~11am-4pm ET

  const contextStr = isDayGame
    ? 'DAY GAME: Batters historically perform slightly worse in afternoon starts (fatigue, glare).'
    : '';

  return { isDayGame, contextStr };
}

module.exports = { detectNBAGameContext, detectMLBGameContext, buildGameContextPromptBlock };
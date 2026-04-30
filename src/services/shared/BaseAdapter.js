/**
 * BaseAdapter.js — Abstract base class for all sport adapters
 *
 * Every sport (NBA, NFL, Soccer, etc.) must have its own adapter
 * that extends this class and implements all required methods.
 *
 * This enforces a consistent interface so InsightService can call
 * any sport's adapter the same way — it never needs to know which sport it is.
 *
 * EXTENDING THIS CLASS:
 *  1. Create /src/services/sports/[sport]/[Sport]Adapter.js
 *  2. Extend BaseAdapter
 *  3. Implement all methods that throw "Not implemented"
 *  4. Register the adapter in adapterRegistry.js
 *
 * Example:
 *   class NBAAdapter extends BaseAdapter {
 *     getRequiredStats() { return ['points', 'usage_rate', 'true_shooting']; }
 *     ...
 *   }
 */

class BaseAdapter {
  constructor(sport) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract — extend it, do not instantiate it directly.');
    }
    this.sport = sport;
  }

  // ─── Data Fetching (must be implemented by each adapter) ──────────────────

  /**
   * Fetch today's schedule / list of games for this sport.
   * Called by the Morning Scraper cron job.
   *
   * @returns {Promise<Array>} Array of normalized game objects
   */
  async fetchSchedule() {
    throw new Error(`[${this.sport}] fetchSchedule() not implemented`);
  }

  /**
   * Fetch player props (betting lines) for a specific game.
   * Called by the Prop Watcher cron job.
   *
   * @param {string} oddsEventId - The Odds API event ID
   * @returns {Promise<Array>} Array of normalized prop objects
   */
  async fetchProps(oddsEventId) {
    throw new Error(`[${this.sport}] fetchProps() not implemented`);
  }

  /**
   * Fetch player statistics for a specific player/game.
   * Called when generating an AI insight.
   *
   * @param {Object} params
   * @param {string|number} params.playerId - Sport-specific player ID
   * @param {string|number} params.gameId   - Sport-specific game/event ID
   * @returns {Promise<Object>} Raw player stats object
   */
  async fetchPlayerStats(params) {
    throw new Error(`[${this.sport}] fetchPlayerStats() not implemented`);
  }

  /**
   * Fetch the current betting line for a specific prop (pre-flight check).
   * This bypasses cache and fetches fresh data from the odds API.
   *
   * @param {string} oddsEventId
   * @param {string} playerName
   * @param {string} statType
   * @returns {Promise<{ line: number, isAvailable: boolean }>}
   */
  async fetchCurrentLine(oddsEventId, playerName, statType) {
    throw new Error(`[${this.sport}] fetchCurrentLine() not implemented`);
  }

  // ─── Formula Engine (must be implemented by each adapter) ─────────────────

  /**
   * Apply sport-specific advanced formulas to raw stats.
   * This is the key step — we compute advanced metrics BEFORE sending to AI.
   *
   * Examples by sport:
   *  NBA: TS% (True Shooting %), USG% (Usage Rate), eFG% (Effective FG%)
   *  Soccer: xG (Expected Goals), Conversion Rate, Key Pass Rate
   *  MLB: BABIP, OPS+, WAR
   *
   * @param {Object} rawStats - Raw stats from the sports API
   * @returns {Object} Processed stats with advanced metrics added
   */
  applyFormulas(rawStats) {
    throw new Error(`[${this.sport}] applyFormulas() not implemented`);
  }

  /**
   * Return the list of stat keys this adapter will process.
   * Used for documentation and validation.
   *
   * @returns {string[]} Array of stat type keys (e.g., ['points', 'rebounds'])
   */
  getRequiredStats() {
    throw new Error(`[${this.sport}] getRequiredStats() not implemented`);
  }

  // ─── AI Prompt Building (must be implemented by each adapter) ─────────────

  /**
   * Build the user-facing prompt string to send to OpenAI.
   * The prompt MUST include the betting line (context injection).
   *
   * This is sport-specific because the relevant stats differ per sport.
   * e.g., NBA prompt references TS%, USG%; Soccer prompt references xG.
   *
   * @param {Object} params
   * @param {Object} params.processedStats  - Stats after applyFormulas()
   * @param {string} params.playerName
   * @param {string} params.statType        - The stat being bet on
   * @param {number} params.bettingLine     - The line (e.g., 25.5)
   * @param {string} params.marketType
   * @returns {string} The full prompt string for OpenAI
   */
  buildPrompt(params) {
    throw new Error(`[${this.sport}] buildPrompt() not implemented`);
  }

  // ─── Strategy Engine (can use defaults or be overridden) ──────────────────

  /**
   * Calculate a confidence score for this prop based on recent game history.
   * Default implementation can be overridden per sport.
   *
   * Formula: (gamesHit / gamesAnalyzed) * 100
   *
   * @param {Object} params
   * @param {number[]} params.recentValues  - Player's recent stat values (last N games)
   * @param {number}   params.line          - The betting line
   * @param {string}   params.direction     - 'over' or 'under'
   * @returns {number} Confidence score 0–100
   */
  calculateConfidence({ recentValues, line, direction }) {
    if (!recentValues || recentValues.length === 0) return 0;

    const hits = recentValues.filter((val) =>
      direction === 'over' ? val > line : val < line
    ).length;

    return Math.round((hits / recentValues.length) * 100);
  }

  /**
   * Calculate the edge percentage — how far the AI prediction is from the line.
   *
   * Formula: (predictedValue - line) / line * 100
   * Positive = OVER edge, Negative = UNDER edge
   *
   * @param {number} predictedValue - AI or formula-estimated player value
   * @param {number} line           - The betting line
   * @returns {number} Edge percentage
   */
  calculateEdge(predictedValue, line) {
    if (!line || line === 0) return 0;
    return parseFloat(((predictedValue - line) / line) * 100).toFixed(2);
  }

  // ─── Normalization helpers ─────────────────────────────────────────────────

  /**
   * Normalize a raw schedule entry from the sport's API into
   * a standard format compatible with Game.model.js
   *
   * @param {Object} rawGame - Raw game object from external API
   * @returns {Object} Normalized game object
   */
  normalizeGame(rawGame) {
    throw new Error(`[${this.sport}] normalizeGame() not implemented`);
  }

  /**
   * Normalize a raw prop entry from The Odds API into
   * a standard format compatible with PlayerProp.model.js
   *
   * @param {Object} rawProp - Raw prop object from The Odds API
   * @returns {Object} Normalized prop object
   */
  normalizeProp(rawProp) {
    throw new Error(`[${this.sport}] normalizeProp() not implemented`);
  }
}

module.exports = BaseAdapter;
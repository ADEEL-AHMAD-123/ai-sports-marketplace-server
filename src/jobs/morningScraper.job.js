/**
 * morningScraper.job.js — Daily schedule fetcher (8 AM cron)
 *
 * Runs once per day at 8 AM.
 * Fetches today's game schedule for all active sports and stores in MongoDB.
 *
 * Why once per day?
 *  - Daily NBA schedules don't change after release
 *  - Avoids wasting API quota on redundant calls
 *  - The Prop Watcher handles individual game updates every 30 min
 */

const cron = require('node-cron');
const { Game } = require('../models/Game.model');
const { getAdapter, getActiveSports } = require('../services/adapters/adapterRegistry');
const logger = require('../config/logger');

/**
 * Main scraper function — can be called directly for testing.
 * @returns {Promise<{ sport: string, upserted: number, errors: number }[]>}
 */
const runMorningScraper = async () => {
  logger.info('📅 [MorningScraper] Starting daily schedule scrape...');

  const activeSports = getActiveSports();
  const results = [];

  for (const sport of activeSports) {
    logger.info(`📅 [MorningScraper] Fetching schedule for: ${sport}`);
    let upserted = 0;
    let errors = 0;

    try {
      const adapter = getAdapter(sport);
      const games = await adapter.fetchSchedule();

      for (const gameData of games) {
        try {
          // Upsert: insert if new, update if already exists
          // We use oddsEventId as the unique identifier
          await Game.findOneAndUpdate(
            { oddsEventId: gameData.oddsEventId },
            { $set: gameData },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          upserted++;
        } catch (upsertErr) {
          errors++;
          logger.error(`[MorningScraper] Failed to upsert game`, {
            sport,
            oddsEventId: gameData.oddsEventId,
            error: upsertErr.message,
          });
        }
      }

      logger.info(`✅ [MorningScraper] ${sport} schedule done`, { upserted, errors, total: games.length });
      results.push({ sport, upserted, errors });
    } catch (err) {
      logger.error(`❌ [MorningScraper] Failed for sport: ${sport}`, { error: err.message });
      results.push({ sport, upserted: 0, errors: 1 });
    }
  }

  logger.info('✅ [MorningScraper] Daily scrape complete', { results });
  return results;
};

/**
 * Register the cron job.
 * Schedule: 8:00 AM every day (server local time).
 * Only runs if CRON_MORNING_SCRAPER_ENABLED=true in .env
 */
const registerMorningScraperJob = () => {
  if (process.env.CRON_MORNING_SCRAPER_ENABLED !== 'true') {
    logger.info('⏭️  [MorningScraper] Cron disabled via CRON_MORNING_SCRAPER_ENABLED=false');
    return;
  }

  // Cron format: second minute hour day month weekday
  // '0 8 * * *' = At 08:00 every day
  cron.schedule('0 8 * * *', async () => {
    logger.info('⏰ [MorningScraper] Cron triggered — 8 AM daily scrape');
    try {
      await runMorningScraper();
    } catch (err) {
      logger.error('❌ [MorningScraper] Cron job crashed', { error: err.message });
    }
  });

  logger.info('✅ [MorningScraper] Cron registered — runs daily at 8:00 AM');
};

module.exports = { registerMorningScraperJob, runMorningScraper };
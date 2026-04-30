/**
 * morningScraper.job.js — Daily schedule fetcher (8 AM cron)
 * After saving games to MongoDB, invalidates the Redis schedule cache
 * so the frontend immediately sees fresh data on next request.
 */

const cron   = require('node-cron');
const { Game } = require('../models/Game.model');
const { getAdapter, getActiveSports } = require('../services/shared/adapterRegistry');
const { cacheDel } = require('../config/redis');
const logger = require('../config/logger');

const runMorningScraper = async () => {
  logger.info('📅 [MorningScraper] Starting daily schedule scrape...');

  const activeSports = getActiveSports();
  const results = [];
  const todayKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  for (const sport of activeSports) {
    logger.info(`📅 [MorningScraper] Fetching schedule for: ${sport}`);
    let upserted = 0;
    let errors   = 0;

    try {
      const adapter = getAdapter(sport);
      const games   = await adapter.fetchSchedule();

      for (const gameData of games) {
        try {
          await Game.findOneAndUpdate(
            { oddsEventId: gameData.oddsEventId },
            { $set: gameData },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          upserted++;
        } catch (upsertErr) {
          errors++;
          logger.error(`[MorningScraper] Failed to upsert game`, {
            sport, oddsEventId: gameData.oddsEventId, error: upsertErr.message,
          });
        }
      }

      // ── Invalidate Redis cache for all date keys this sport has games on ──
      // Games span multiple days so we clear all relevant keys
      const uniqueDates = [...new Set(games.map(g =>
        new Date(g.startTime || g.commence_time).toISOString().split('T')[0]
      ))];
      for (const dateKey of uniqueDates) {
        await cacheDel(`schedule:${sport}:${dateKey}`);
      }
      // Always clear today's key
      await cacheDel(`schedule:${sport}:${todayKey}`);
      logger.info(`🗑️  [MorningScraper] Cache invalidated for ${sport} (${uniqueDates.length} date keys)`);

      logger.info(`✅ [MorningScraper] ${sport} done`, { upserted, errors, total: games.length });
      results.push({ sport, upserted, errors });

    } catch (err) {
      logger.error(`❌ [MorningScraper] Failed for sport: ${sport}`, { error: err.message });
      results.push({ sport, upserted: 0, errors: 1 });
    }
  }

  logger.info('✅ [MorningScraper] Daily scrape complete', { results });
  return results;
};

const registerMorningScraperJob = () => {
  if (process.env.CRON_MORNING_SCRAPER_ENABLED !== 'true') {
    logger.info('⏭️  [MorningScraper] Disabled via env');
    return;
  }
  cron.schedule('0 8 * * *', async () => {
    logger.info('⏰ [MorningScraper] Cron triggered');
    try { await runMorningScraper(); }
    catch (err) { logger.error('❌ [MorningScraper] Cron crashed', { error: err.message }); }
  });
  logger.info('✅ [MorningScraper] Cron registered — runs daily at 8:00 AM');
};

module.exports = { registerMorningScraperJob, runMorningScraper };
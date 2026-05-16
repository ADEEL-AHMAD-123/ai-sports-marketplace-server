/**
 * server.js — Application entry point
 *
 * Startup sequence:
 *  1. Load environment variables
 *  2. Connect to MongoDB
 *  3. Connect to Redis (non-blocking — app works with degraded cache if Redis is down)
 *  4. Start HTTP server
 *  5. Register all cron jobs
 *
 * This file is intentionally minimal — all app logic lives in src/app.js.
 */

require('dotenv').config();

const app = require('./src/app');
const connectDB = require('./src/config/database');
const { redisClient } = require('./src/config/redis');
const logger = require('./src/config/logger');
const JobQueueService = require('./src/services/queue/JobQueueService');

// ── Cron Jobs ──────────────────────────────────────────────────────────────────
const { registerMorningScraperJob } = require('./src/jobs/morningScraper.job');
const { registerPropWatcherJob }    = require('./src/jobs/orchestrators/propWatcher.job');
const { registerPostGameSyncJob }   = require('./src/jobs/orchestrators/postGameSync.job');
const { registerInjuryRefreshJob }  = require('./src/jobs/injuryRefresh.job');

const PORT = parseInt(process.env.PORT || '5000', 10);

const startServer = async () => {
  try {
    logger.info('🚀 Starting AI Sports Insight Marketplace server...');
    logger.info(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);

    // ── Step 1: Connect to MongoDB ─────────────────────────────────────────
    await connectDB();

    // ── Step 2: Redis connection is non-blocking (handled in redis.js events)
    // The app will work with degraded caching if Redis is unavailable.
    // redis.js logs 'ready' when connected.

    // ── Step 3: Start HTTP server ──────────────────────────────────────────
    const server = app.listen(PORT, () => {
      logger.info(`✅ Server running on port ${PORT}`, {
        port: PORT,
        environment: process.env.NODE_ENV,
        nodeVersion: process.version,
      });

      logger.info('📡 API endpoints:');
      logger.info(`   Auth:     http://localhost:${PORT}/api/auth`);
      logger.info(`   Odds:     http://localhost:${PORT}/api/odds`);
      logger.info(`   Insights: http://localhost:${PORT}/api/insights`);
      logger.info(`   Credits:  http://localhost:${PORT}/api/credits`);
      logger.info(`   Health:   http://localhost:${PORT}/health`);
    });

    // ── Step 4: Register cron jobs ─────────────────────────────────────────
    registerMorningScraperJob();
    registerPropWatcherJob();
    registerPostGameSyncJob();
    registerInjuryRefreshJob();

    if (JobQueueService.isEnabled()) {
      await JobQueueService.startWorkers();
    } else {
      logger.info('⏭️  Job queues disabled (JOB_QUEUE_ENABLED=false or REDIS disabled)');
    }

    logger.info('⏰ Cron jobs registered');

    // ── Graceful shutdown handling ─────────────────────────────────────────
    // Allows in-flight requests to complete before shutting down
    const gracefulShutdown = async (signal) => {
      logger.info(`\n📴 Received ${signal} — starting graceful shutdown...`);

      server.close(async () => {
        logger.info('✅ HTTP server closed');

        if (JobQueueService.isEnabled()) {
          await JobQueueService.close();
          logger.info('✅ Queue workers closed');
        }

        // MongoDB and Redis shutdown are handled in their own modules
        // (database.js and redis.js both listen for SIGINT/SIGTERM)

        logger.info('✅ Graceful shutdown complete. Goodbye! 👋');
        process.exit(0);
      });

      // Force exit after 10 seconds if graceful shutdown stalls
      setTimeout(() => {
        logger.error('❌ Graceful shutdown timed out — forcing exit');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Catch any unhandled promise rejections not caught by Winston handlers
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('❌ Unhandled Promise Rejection', {
        reason: reason?.message || reason,
        stack: reason?.stack,
      });
    });

    process.on('uncaughtException', (err) => {
      logger.error('💀 Uncaught Exception — process will exit', {
        error: err.message,
        stack: err.stack,
      });
      process.exit(1);
    });

  } catch (err) {
    logger.error('💀 Server startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};

startServer();
/**
 * database.js — MongoDB connection manager
 *
 * Handles:
 *  - Initial connection with retry logic
 *  - Connection event logging (connected, error, disconnected)
 *  - Graceful shutdown hook
 *  - Performance: lean queries encouraged via mongoose settings
 */

const mongoose = require('mongoose');
const logger = require('./logger');

// ─── Mongoose global settings ─────────────────────────────────────────────────
// Strict mode: reject fields not in schema (prevents dirty writes)
mongoose.set('strictQuery', true);

/**
 * Connect to MongoDB.
 * Called once at server startup.
 * Exits process if connection fails after retries (fail-fast in prod).
 *
 * @param {number} retries - Number of retry attempts (default: 5)
 * @param {number} delay   - Delay in ms between retries (default: 5000)
 */
const connectDB = async (retries = 5, delay = 5000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI, {
        // These are the recommended options for Mongoose 7+
        // Connection pool: how many simultaneous connections are allowed
        maxPoolSize: 10,
        // How long to wait for a connection from the pool (ms)
        serverSelectionTimeoutMS: 5000,
        // How long a send or receive on a socket can take (ms)
        socketTimeoutMS: 45000,
      });

      logger.info('✅ MongoDB connected', {
        host: conn.connection.host,
        database: conn.connection.name,
        attempt,
      });

      return; // Success — stop retrying
    } catch (error) {
      logger.error(`❌ MongoDB connection failed (attempt ${attempt}/${retries})`, {
        error: error.message,
      });

      if (attempt === retries) {
        logger.error('💀 All MongoDB connection attempts exhausted. Exiting.');
        process.exit(1);
      }

      logger.info(`⏳ Retrying MongoDB connection in ${delay / 1000}s...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
};

// ─── Connection event listeners ───────────────────────────────────────────────

// Lost connection AFTER initially connecting (e.g. network blip)
mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️  MongoDB disconnected. Mongoose will auto-reconnect.');
});

// Mongoose successfully reconnected after a disconnection
mongoose.connection.on('reconnected', () => {
  logger.info('✅ MongoDB reconnected.');
});

// Low-level connection error event
mongoose.connection.on('error', (err) => {
  logger.error('❌ MongoDB connection error', { error: err.message });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// When the process receives a termination signal, close the DB connection cleanly
// so in-flight operations complete and no data is lost.
const gracefulShutdown = async (signal) => {
  logger.info(`📴 Received ${signal}. Closing MongoDB connection...`);
  await mongoose.connection.close();
  logger.info('✅ MongoDB connection closed. Process exiting.');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C in terminal
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker / PM2 stop

module.exports = connectDB;
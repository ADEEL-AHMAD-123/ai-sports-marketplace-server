/**
 * redis.js — Redis cache client
 *
 * Uses ioredis for:
 *  - Caching betting odds (HOT layer — short TTL)
 *  - Caching daily schedules
 *  - Caching player props
 *
 * Exports a singleton client + helper wrappers (get, set, del, exists)
 * so the rest of the app never touches ioredis directly.
 *
 * Cache key naming convention:
 *   odds:{sport}:{eventId}
 *   schedule:{sport}:{date}
 *   props:{sport}:{eventId}
 */

const Redis = require('ioredis');
const logger = require('./logger');

// ─── Redis enabled flag ───────────────────────────────────────────────────────
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false';

// ─── Build connection config from env ────────────────────────────────────────
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  db: parseInt(process.env.REDIS_DB || '0', 10),
  // Retry strategy: exponential back-off up to 30 seconds
  retryStrategy(times) {
    const delay = Math.min(times * 500, 30000);
    logger.warn(`⏳ Redis retry attempt #${times}. Next attempt in ${delay}ms`);
    return delay;
  },
  // Lazy connect: don't connect until first command
  lazyConnect: true,
  // Max reconnection attempts (null = unlimited)
  maxRetriesPerRequest: 3,
};

// Only add password if provided (avoids Redis auth error on local dev)
if (process.env.REDIS_PASSWORD) {
  redisConfig.password = process.env.REDIS_PASSWORD;
}

// ─── Create singleton client (or null stub when disabled) ────────────────────
const redisClient = REDIS_ENABLED ? new Redis(redisConfig) : null;

if (REDIS_ENABLED) {
  // ─── Connection event logging ───────────────────────────────────────────────
  redisClient.on('connect', () => {
    logger.info('✅ Redis connecting...');
  });

  redisClient.on('ready', () => {
    logger.info('✅ Redis ready.', {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      db: process.env.REDIS_DB,
    });
  });

  redisClient.on('error', (err) => {
    // Log but don't crash — app can run with degraded caching if Redis is down
    logger.error('❌ Redis error', { error: err.message });
  });

  redisClient.on('close', () => {
    logger.warn('⚠️  Redis connection closed.');
  });

  redisClient.on('reconnecting', () => {
    logger.info('🔄 Redis reconnecting...');
  });
} else {
  logger.warn('⚠️  Redis is disabled (REDIS_ENABLED=false). All cache calls are no-ops.');
}

// ─── Helper wrappers ──────────────────────────────────────────────────────────

/**
 * Get a cached value by key.
 * Returns parsed JSON if the value is a JSON string, otherwise returns raw string.
 * Returns null if key does not exist.
 *
 * @param {string} key
 * @returns {Promise<any|null>}
 */
const cacheGet = async (key) => {
  if (!REDIS_ENABLED) return null;
  try {
    const value = await redisClient.get(key);
    if (value === null) return null;

    // Try to parse as JSON; return raw string if not valid JSON
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } catch (err) {
    logger.error('❌ Redis GET error', { key, error: err.message });
    return null; // Fail gracefully — cache miss is better than a crash
  }
};

/**
 * Set a cache value with an optional TTL (in seconds).
 * Automatically serializes objects/arrays to JSON.
 *
 * @param {string} key
 * @param {any} value
 * @param {number} [ttl]  - TTL in seconds. If omitted, key never expires.
 * @returns {Promise<boolean>} - true on success
 */
const cacheSet = async (key, value, ttl) => {
  if (!REDIS_ENABLED) return false;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (ttl) {
      await redisClient.set(key, serialized, 'EX', ttl);
    } else {
      await redisClient.set(key, serialized);
    }

    logger.debug('💾 Redis SET', { key, ttl: ttl || 'no-expire' });
    return true;
  } catch (err) {
    logger.error('❌ Redis SET error', { key, error: err.message });
    return false;
  }
};

/**
 * Delete one or more keys from cache.
 *
 * @param {...string} keys
 * @returns {Promise<number>} - number of keys deleted
 */
const cacheDel = async (...keys) => {
  if (!REDIS_ENABLED) return 0;
  try {
    const count = await redisClient.del(...keys);
    logger.debug('🗑️  Redis DEL', { keys, deletedCount: count });
    return count;
  } catch (err) {
    logger.error('❌ Redis DEL error', { keys, error: err.message });
    return 0;
  }
};

/**
 * Check if a key exists in cache.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
const cacheExists = async (key) => {
  if (!REDIS_ENABLED) return false;
  try {
    const count = await redisClient.exists(key);
    return count > 0;
  } catch (err) {
    logger.error('❌ Redis EXISTS error', { key, error: err.message });
    return false;
  }
};

/**
 * Delete all keys matching a pattern.
 * Use carefully — SCAN is used (not KEYS) to avoid blocking Redis.
 * Example: cacheClear('odds:nba:*') clears all NBA odds
 *
 * @param {string} pattern
 * @returns {Promise<number>} - number of keys deleted
 */
const cacheClear = async (pattern) => {
  if (!REDIS_ENABLED) return 0;
  try {
    let cursor = '0';
    let totalDeleted = 0;

    do {
      // SCAN is non-blocking; KEYS would block Redis on large datasets
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redisClient.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    logger.debug('🗑️  Redis pattern clear', { pattern, totalDeleted });
    return totalDeleted;
  } catch (err) {
    logger.error('❌ Redis pattern clear error', { pattern, error: err.message });
    return 0;
  }
};

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  if (redisClient) await redisClient.quit();
  logger.info('✅ Redis connection closed on SIGINT.');
});

process.on('SIGTERM', async () => {
  if (redisClient) await redisClient.quit();
  logger.info('✅ Redis connection closed on SIGTERM.');
});

module.exports = {
  redisClient,  // Raw client (for advanced use if needed)
  cacheGet,
  cacheSet,
  cacheDel,
  cacheExists,
  cacheClear,
};
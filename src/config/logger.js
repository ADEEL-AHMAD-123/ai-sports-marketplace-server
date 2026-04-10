/**
 * logger.js — Application-wide logger
 *
 * Uses Winston with:
 *  - Colorized console output (great for development debugging)
 *  - Daily rotating file logs (info + errors separated)
 *  - JSON format in files (easy to parse / search in production)
 *  - Automatic log deletion after LOG_RETENTION_DAYS
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('Server started');
 *   logger.error('Something broke', { error: err.message });
 *   logger.debug('Cache hit', { key, ttl });
 *   logger.http('Incoming request', { method, url });
 */

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_RETENTION_DAYS = `${process.env.LOG_RETENTION_DAYS || 14}d`;
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '20m';

// ─── Custom format for console (human-readable with colors) ──────────────────
const consoleFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    // Pretty-print any extra metadata (e.g. error details, sport name)
    const metaStr = Object.keys(meta).length
      ? `\n  ${JSON.stringify(meta, null, 2)}`
      : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

// ─── JSON format for log files (structured, searchable) ──────────────────────
const fileFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }), // Include stack traces in files
  format.json()
);

// ─── Daily rotating file transport — ALL logs (info and above) ───────────────
const combinedFileTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,          // Compress old log files to save disk space
  maxSize: LOG_MAX_SIZE,
  maxFiles: LOG_RETENTION_DAYS, // Auto-deletes files older than retention period
  level: 'info',
  format: fileFormat,
});

// ─── Daily rotating file transport — ERROR logs only ─────────────────────────
const errorFileTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: LOG_MAX_SIZE,
  maxFiles: LOG_RETENTION_DAYS,
  level: 'error',
  format: fileFormat,
});

// ─── Build logger ─────────────────────────────────────────────────────────────
const logger = createLogger({
  level: LOG_LEVEL,
  transports: [
    new transports.Console({ format: consoleFormat }),
    combinedFileTransport,
    errorFileTransport,
  ],
  // Catch uncaught exceptions and log them before the process exits
  exceptionHandlers: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'exceptions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: LOG_RETENTION_DAYS,
      format: fileFormat,
    }),
  ],
  // Catch unhandled promise rejections
  rejectionHandlers: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'rejections-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: LOG_RETENTION_DAYS,
      format: fileFormat,
    }),
  ],
});

module.exports = logger;
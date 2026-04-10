/**
 * app.js — Express application factory
 *
 * Sets up:
 *  - Security middleware (helmet, cors, rate limiting, sanitization)
 *  - Request logging (morgan → winston)
 *  - Body parsing (JSON + raw for Stripe webhook)
 *  - All API routes
 *  - Error handling
 *
 * This file does NOT start the server — that's server.js.
 * Separation of app and server makes testing easier.
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');

const logger = require('./config/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler.middleware');

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes    = require('./routes/auth.routes');
const oddsRoutes    = require('./routes/odds.routes');
const insightRoutes = require('./routes/insight.routes');
const creditRoutes  = require('./routes/credit.routes');

const app = express();

// ─── Security: Helmet ──────────────────────────────────────────────────────────
// Sets security-related HTTP headers (XSS protection, clickjacking prevention, etc.)
app.use(helmet());

// ─── Security: CORS ────────────────────────────────────────────────────────────
// Only allow requests from your frontend domain
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server requests (no origin) and allowed origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`⚠️  [CORS] Blocked request from: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true, // Allow cookies (needed for httpOnly auth cookie)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ─── Security: Rate Limiting ───────────────────────────────────────────────────
// Protects against brute force and DoS attacks
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
  handler: (req, res, next, options) => {
    logger.warn('⚠️  [RateLimit] Rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json(options.message);
  },
});

// Stricter rate limit for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 login attempts per 15 min
  message: {
    success: false,
    message: 'Too many authentication attempts. Please wait 15 minutes.',
  },
});

app.use('/api', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─── Body Parsing ──────────────────────────────────────────────────────────────
// ⚠️  IMPORTANT: Stripe webhook MUST receive raw body for signature verification.
// Register raw parser for the webhook route BEFORE express.json().

app.use('/api/credits/webhook', express.raw({ type: 'application/json' }));

// Regular JSON parsing for all other routes
app.use(express.json({ limit: '10kb' })); // Limit body size to prevent large payload attacks
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Security: Input Sanitization ─────────────────────────────────────────────
// Prevents MongoDB operator injection (e.g., { "$gt": "" } in request body)
app.use(mongoSanitize());

// ─── Performance: Compression ─────────────────────────────────────────────────
// Gzip compress all responses — reduces bandwidth significantly
app.use(compression());

// ─── HTTP Request Logging ──────────────────────────────────────────────────────
// Morgan logs every HTTP request to Winston
const morganFormat = process.env.NODE_ENV === 'production'
  ? 'combined'   // Full log in production
  : 'dev';       // Colorized short log in development

app.use(
  morgan(morganFormat, {
    stream: {
      // Pipe morgan output through Winston so all logs go to the same files
      write: (message) => logger.http(message.trim()),
    },
    // Skip health check route from logs (would be very noisy)
    skip: (req) => req.path === '/health',
  })
);

// ─── Health Check ──────────────────────────────────────────────────────────────
// Used by load balancers and monitoring tools (Docker, Kubernetes, etc.)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/odds',     oddsRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/credits',  creditRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use(notFoundHandler);

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Must be the LAST middleware registered
app.use(errorHandler);

module.exports = app;
/**
 * insight.routes.js — AI insight routes
 *
 * Most routes require authentication (unlocking an insight, viewing
 * one's own, etc.). Two public endpoints (scout-closings, featured-recent)
 * are mounted BEFORE the `protect` middleware so the homepage and hero
 * carousel can consume them without a logged-in user.
 */
const express = require('express');
const router = express.Router();
const insightController = require('../controllers/insight.controller');
const { protect } = require('../middleware/auth.middleware');
const {
  validateInsightRequest,
  validatePagination,
} = require('../middleware/validate.middleware');

// ── Public (no auth) — real success-proof feeds for the homepage ─────────────
// GET /api/insights/scout-closings?limit=10&perSportMin=2
router.get('/scout-closings',  insightController.getScoutClosings);
// GET /api/insights/featured-recent?limit=3
router.get('/featured-recent', insightController.getFeaturedRecent);

// All other insight routes require authentication
router.use(protect);

// POST /api/insights/unlock — Unlock a new insight (deducts 1 credit)
router.post('/unlock', validateInsightRequest, insightController.unlockInsight);

// GET /api/insights/unlock-jobs/:jobId — Poll queue-backed unlock status
router.get('/unlock-jobs/:jobId', insightController.getUnlockJobStatus);

// GET /api/insights/my-history — Current user's unlocked insights
router.get('/my-history', validatePagination, insightController.listMyHistory);

// GET /api/insights — List insights with optional filters
router.get('/', validatePagination, insightController.listInsights);

// GET /api/insights/:id — Get a specific insight
router.get('/:id', insightController.getInsight);

module.exports = router;

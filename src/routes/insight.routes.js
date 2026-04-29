/**
 * insight.routes.js — AI insight routes (all protected)
 */
const express = require('express');
const router = express.Router();
const insightController = require('../controllers/insight.controller');
const { protect } = require('../middleware/auth.middleware');
const {
  validateInsightRequest,
  validatePagination,
} = require('../middleware/validate.middleware');

// All insight routes require authentication
router.use(protect);

// POST /api/insights/unlock — Unlock a new insight (deducts 1 credit)
router.post('/unlock', validateInsightRequest, insightController.unlockInsight);

// GET /api/insights/my-history — Current user's unlocked insights
router.get('/my-history', validatePagination, insightController.listMyHistory);

// GET /api/insights — List insights with optional filters
router.get('/', validatePagination, insightController.listInsights);

// GET /api/insights/:id — Get a specific insight
router.get('/:id', insightController.getInsight);

module.exports = router;
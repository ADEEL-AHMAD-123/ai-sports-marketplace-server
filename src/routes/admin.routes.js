/**
 * admin.routes.js — Admin-only routes
 * All routes require: valid JWT + role === 'admin'
 */
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, restrictTo } = require('../middleware/auth.middleware');
const { USER_ROLES } = require('../config/constants');

// Apply auth + admin role check to ALL admin routes
router.use(protect, restrictTo(USER_ROLES.ADMIN));

// ── Platform stats
router.get('/stats', adminController.getPlatformStats);

// ── User management
router.get('/users',                     adminController.listUsers);
router.get('/users/:id',                 adminController.getUserDetail);
router.patch('/users/:id/credits',       adminController.adjustUserCredits);
router.patch('/users/:id/status',        adminController.setUserStatus);

// ── Player ID cache health (REMOVED)
// Player ID resolution now runs entirely automatically inside
// InsightOutcomeService — no admin UI surface needed.

// ── Cron job triggers
router.post('/cron/:job',                adminController.triggerCronJob);

// ── Insight management
router.get('/insights',                  adminController.listInsights);
router.delete('/insights/:id',           adminController.deleteInsight);

// ── AI logs (REMOVED)
// aiLog entries are now auto-pruned by the daily 3AM cleanup cron via
// aiLogExpiresAt TTL. No admin UI surface needed.

// ── Performance / per-game outcome audit
router.get('/performance/games',                 adminController.getPerGameReport);
router.get('/performance/games/:eventId',        adminController.getGameDetail);
router.get('/performance/archive',               adminController.getArchiveSnapshot);
router.post('/performance/prune-exhausted',      adminController.pruneExhaustedRetries);
router.post('/performance/archive-graded',       adminController.archiveAndPruneGraded);

module.exports = router;
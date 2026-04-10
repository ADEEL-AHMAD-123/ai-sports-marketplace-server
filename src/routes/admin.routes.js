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

// ── Cron job triggers
router.post('/cron/:job',                adminController.triggerCronJob);

// ── Insight management
router.get('/insights',                  adminController.listInsights);
router.delete('/insights/:id',           adminController.deleteInsight);

// ── AI logs
router.get('/logs/ai',                   adminController.getAILogs);

module.exports = router;
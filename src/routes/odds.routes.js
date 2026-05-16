/**
 * odds.routes.js — Public odds and games routes
 *
 * All routes here are PUBLIC (no auth required).
 * Guest users can browse sports, games, and see blurred props.
 *
 * optionalAuth is used to personalize the response (show unlocked state)
 * for authenticated users without blocking guests.
 */
const express = require('express');
const router = express.Router();
const oddsController = require('../controllers/odds.controller');
const { optionalAuth } = require('../middleware/auth.middleware');
const { validateSportParam, validateEventIdParam } = require('../middleware/validate.middleware');

// GET /api/odds/sports
router.get('/sports', oddsController.getSports);

// GET /api/odds/:sport/games
router.get('/:sport/games', validateSportParam, optionalAuth, oddsController.getGames);

// GET /api/odds/:sport/games/:eventId/props
router.get(
  '/:sport/games/:eventId/props',
  validateSportParam,
  validateEventIdParam,
  optionalAuth,
  oddsController.getProps
);

// POST /api/odds/:sport/games/:eventId/refresh — Refresh props from live bookies
router.post(
  '/:sport/games/:eventId/refresh',
  validateSportParam,
  validateEventIdParam,
  optionalAuth,
  oddsController.refreshProps
);

module.exports = router;
/**
 * NHLInjuryService.js — NHL injury stub
 * No injury API support for NHL yet.
 * Placeholder so the folder is consistent with NBA and MLB.
 * When API-Sports Hockey adds an injuries endpoint, implement it here.
 */

async function getInjuryMap() { return new Map(); }
async function getPlayerInjury() { return null; }
async function getInjuryPromptContext() { return null; }

module.exports = { getInjuryMap, getPlayerInjury, getInjuryPromptContext };
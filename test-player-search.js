#!/usr/bin/env node
/**
 * test-player-search.js
 * Run from server/ directory: node test-player-search.js
 * Tests the NBA v2 API player search endpoint directly
 */
require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.API_NBA_KEY;
const BASE_URL = process.env.API_NBA_BASE_URL || 'https://v2.nba.api-sports.io';

async function test(nameParam, extraParams = {}) {
  console.log(`\n[Search Test] GET ${BASE_URL}/players`);
  console.log('   Params:', { search: nameParam, ...extraParams });
  console.log('   Key:   ', API_KEY ? API_KEY.slice(0, 8) + '...' : 'MISSING');

  try {
    const res = await axios.get(`${BASE_URL}/players`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { search: nameParam, ...extraParams },
      timeout: 10000,
    });
    console.log('   Status:  ', res.status);
    console.log('   Results: ', res.data?.results);
    console.log('   Errors:  ', res.data?.errors);
    console.log(
      '   Players: ',
      (res.data?.response || []).slice(0, 3).map((p) => ({
        id: p.id,
        name: `${p.firstname} ${p.lastname}`,
        team: p.leagues?.standard?.team?.name,
      }))
    );
  } catch (e) {
    console.log('   ERROR:   ', e.response?.status, e.response?.data || e.message);
  }
}

async function main() {
  console.log('=== NBA v2 Player Search Test ===');
  console.log('BASE_URL:', BASE_URL);
  console.log('API_KEY:', API_KEY ? 'SET' : 'MISSING');

  if (!API_KEY) {
    console.log('\nNo API key - check API_NBA_KEY in .env');
    process.exit(1);
  }

  // Test 1: full name search
  await test('Tyrese Maxey');

  // Test 2: suffix/variant style name search
  await test('Kelly Oubre Jr');

  // Test 3: last name only
  await test('Maxey');

  // Test 4: id lookup (used after resolver picks player id)
  console.log('\n[Search Test] id lookup');
  try {
    const res = await axios.get(`${BASE_URL}/players`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { id: 2619 },
      timeout: 10000,
    });
    console.log('   id= results:', res.data?.results, 'errors:', res.data?.errors);
    console.log('   Player:', (res.data?.response || []).slice(0, 1).map((p) => `${p.firstname} ${p.lastname}`));
  } catch (e) {
    console.log('   ERROR:', e.response?.status, e.message);
  }

  // Test 5: check the stats endpoint used by NBAAdapter
  console.log('\n[Search Test] checking working stats endpoint for comparison');
  try {
    const res = await axios.get(`${BASE_URL}/players/statistics`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { id: 2619, season: 2025 },
      timeout: 10000,
    });
    console.log('   Stats results:', res.data?.results, '- player stats API works');
  } catch (e) {
    console.log('   ERROR:', e.response?.status, e.message);
  }
}

main().catch(console.error);

/**
 * jest.config.js
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Show individual test names in output
  verbose: true,
  // How long before a test times out (ms) — set higher for DB tests
  testTimeout: 15000,
  // Collect coverage from src only
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/jobs/**',      // Crons are hard to unit-test
    '!src/config/**',
  ],
  // Clear mocks between tests
  clearMocks: true,
  // Setup file that runs before all tests
  setupFilesAfterEnv: [],
};
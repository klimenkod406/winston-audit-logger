/**
 * Plain CommonJS - no transform needed, so no babel-jest dependency.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 90,
      lines: 85,
      statements: 85,
    },
  },
};

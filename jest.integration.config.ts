import type { Config } from 'jest';
import unit from './jest.config.ts';

// Integration tests run against real systems and read the local .env on
// purpose, so they skip the unit-test isolation from local env files.
const { setupFiles: _unitOnly, ...shared } = unit;

const config: Config = {
  ...shared,
  testMatch: ['**/test/integration/**/*.test.ts'],
};

export default config;

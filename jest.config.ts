import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/unit/**/*.test.ts'],
  moduleNameMapper: {
    '^@sap/cds$': '<rootDir>/node_modules/@cap-js/cds-types',
  },
};

export default config;

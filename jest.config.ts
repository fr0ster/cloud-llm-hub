import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/unit/**/*.test.ts'],
  moduleNameMapper: {
    '^@sap/cds$': '<rootDir>/node_modules/@cap-js/cds-types',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};

export default config;

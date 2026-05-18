import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/unit/**/*.test.ts'],
  moduleNameMapper: {
    '^@sap/cds$': '<rootDir>/node_modules/@sap/cds',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    '^.+\\.js$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@mcp-abap-adt|@sap-ai-sdk)/)',
  ],
};

export default config;

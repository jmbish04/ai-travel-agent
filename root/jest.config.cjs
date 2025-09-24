const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 45000,
  forceExit: true,
  detectOpenHandles: true,
  testSequencer: '<rootDir>/tests/custom-sequencer.cjs',
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Coverage configuration
  collectCoverage: process.env.COVERAGE === 'true',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/cli.ts',
    '!src/api/server.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'clover', 'json'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },
  globals: {
    'ts-jest': {
      tsconfig: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        types: ['jest', 'node']
      }
    }
  }
};

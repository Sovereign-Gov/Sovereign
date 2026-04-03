import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Use in-memory SQLite for tests
  setupFilesAfterEnv: [],
  verbose: true,
  // Prevent tests from running in parallel (shared DB state)
  maxWorkers: 1,
};

export default config;

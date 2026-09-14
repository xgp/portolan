import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The sandbox and fixture-server suites bind ports and spawn processes; keeping
    // files in separate forks avoids cross-test interference.
    pool: 'forks',
    reporters: ['default'],
    coverage: { provider: 'v8', reportsDirectory: 'coverage' },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.mjs'],
    setupFiles: ['claude-code-testbed/matchers'],
    testTimeout: 420_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

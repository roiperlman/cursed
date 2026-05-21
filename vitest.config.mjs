import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e tests require the testbed (tmux + OAuth + cursor-agent) and run
    // under vitest.config.e2e.mjs. Exclude them from the default suite so
    // `npm test` stays fast and prerequisite-free.
    exclude: ['**/test/e2e/**', '.cursed/**', '.claude/**', 'node_modules/**'],
    // Tests that use process.chdir() are not supported in worker threads.
    // Route them to the forks pool (child process) instead.
    poolMatchGlobs: [
      ['**/delegate-worktree.test.mjs', 'forks'],
      ['**/delegate-background.test.mjs', 'forks'],
    ],
  },
});

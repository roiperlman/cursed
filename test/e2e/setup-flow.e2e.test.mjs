/**
 * Scenario: /cursed:setup interactive configurator.
 *
 * Drives a real Claude Code session through the setup flow with a throwaway
 * CLAUDE_PLUGIN_DATA dir, accepting default answers, and asserts config.toml
 * is created and parses. Host-side behavior — not coverable by smoke tests.
 *
 * Real model calls: gated behind TESTBED_E2E=1, kept out of CI.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { REPO_ROOT, answerQuestions, lib } from './helpers.mjs';

describe('e2e: /cursed:setup configurator', () => {
  it.skipIf(!process.env.TESTBED_E2E)(
    'probes adapters, asks questions, and writes config.toml',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'cursed-setup-e2e-'));

      // lib.start does not accept an env option; set CLAUDE_PLUGIN_DATA on the
      // process so the MCP server picks it up via dataDir() in state.mjs.
      const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_PLUGIN_DATA = dataDir;

      let session;
      try {
        session = await lib.start({
          projectDir: REPO_ROOT,
          pluginDir: REPO_ROOT,
          model: 'haiku',
          bare: false,
          name: 'e2e-setup-flow',
        });

        await lib.slash(session.id, '/cursed:setup');
        await answerQuestions(session.id, { timeoutMs: 240_000 });

        // Give the model a moment to call config_apply after the last answer.
        await lib.waitIdle(session.id, { timeoutMs: 60_000, idleMs: 3_000 }).catch(() => {});

        const toml = await readFile(join(dataDir, 'config.toml'), 'utf8');
        const parsed = TOML.parse(toml);
        expect(parsed.adapters).toBeDefined();
        expect(parsed.panel).toBeDefined();
      } finally {
        // Restore env before cleanup so other tests are unaffected.
        if (prevDataDir === undefined) {
          delete process.env.CLAUDE_PLUGIN_DATA;
        } else {
          process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
        }
        if (session) await lib.kill(session.id).catch(() => {});
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    360_000,
  );
});

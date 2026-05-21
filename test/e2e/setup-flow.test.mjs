/**
 * Scenario: /cursed:setup interactive configurator.
 *
 * Drives a real Claude Code session through the setup flow, accepting default
 * answers, and asserts config.toml is created with the expected structure.
 * Host-side behavior — not coverable by smoke tests.
 *
 * Real model calls: gated behind TESTBED_E2E=1, kept out of CI.
 *
 * Note on isolation: Claude Code injects CLAUDE_PLUGIN_DATA for the MCP
 * subprocess; we cannot override it from the test process. The config is
 * written to the Claude Code-managed plugin data dir
 * (~/.claude/plugins/data/cursed-inline/config.toml). The test backs up any
 * existing config, runs setup, asserts the config, then restores the backup.
 */
import { describe, it, expect } from 'vitest';
import { readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { REPO_ROOT, answerQuestions, lib } from './helpers.mjs';

/** Path where Claude Code writes the config when loading this plugin inline. */
const CONFIG_PATH = join(homedir(), '.claude', 'plugins', 'data', 'cursed-inline', 'config.toml');
const BACKUP_PATH = `${CONFIG_PATH}.e2e-bak`;

describe('e2e: /cursed:setup configurator', () => {
  it.skipIf(!process.env.TESTBED_E2E)(
    'probes adapters, asks questions, and writes config.toml',
    async () => {
      // Back up any existing config so the test is non-destructive.
      let hadBackup = false;
      try {
        await rename(CONFIG_PATH, BACKUP_PATH);
        hadBackup = true;
      } catch {
        // No existing config — nothing to back up.
      }

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

        const toml = await readFile(CONFIG_PATH, 'utf8');
        const parsed = TOML.parse(toml);
        expect(parsed.adapters).toBeDefined();
        expect(parsed.panel).toBeDefined();
      } finally {
        if (session) await lib.kill(session.id).catch(() => {});
        if (hadBackup) {
          // Restore the original config.
          await rename(BACKUP_PATH, CONFIG_PATH).catch(() => {});
        } else {
          // No original config — remove the one the test wrote.
          await rm(CONFIG_PATH, { force: true }).catch(() => {});
        }
      }
    },
    360_000,
  );
});

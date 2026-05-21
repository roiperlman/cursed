import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as lib from 'claude-code-testbed';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

// Verified against Claude Code 2.1.121. If a future claude release changes the
// JSONL event shape, this version pin tells you where the assertion shape was last
// confirmed.
const _PINNED_CLAUDE_VERSION = '2.1.121';

describe.skipIf(!process.env.TESTBED_E2E)('integration: testbed end-to-end', () => {
  it('start → send → waitIdle → events → kill', async () => {
    const session = await lib.start({
      projectDir: REPO_ROOT,
      pluginDir: REPO_ROOT,
      model: 'haiku',
      // NOTE: `--bare` produces "Not logged in" in claude 2.1.121 with OAuth
      // user auth — the flag bypasses the normal credential lookup and
      // expects ANTHROPIC_API_KEY in env. Default is true for plugin isolation
      // in lib.start; this test opts out so the user's normal auth applies.
      bare: false,
      name: 'e2e',
    });
    try {
      await lib.send(session.id, 'Reply with just one word: pong');
      await lib.waitIdle(session.id, { timeoutMs: 60_000, idleMs: 2_000 });
      const events = await lib.events(session.id);
      const assistantText = events
        .filter((e) => e.type === 'assistant')
        .flatMap((e) => {
          const c = /** @type {unknown[] | undefined} */ (
            /** @type {Record<string, unknown> | undefined} */ (e.message)?.content
          );
          if (!Array.isArray(c)) return /** @type {string[]} */ ([]);
          return c
            .filter(
              (p) =>
                p !== null &&
                typeof p === 'object' &&
                /** @type {Record<string, unknown>} */ (p).type === 'text' &&
                typeof (/** @type {Record<string, unknown>} */ (p).text) === 'string',
            )
            .map((p) => /** @type {string} */ (/** @type {Record<string, unknown>} */ (p).text));
        })
        .join(' ');
      expect(assistantText.toLowerCase()).toContain('pong');
    } finally {
      await lib.kill(session.id);
    }
  }, 120_000);
});

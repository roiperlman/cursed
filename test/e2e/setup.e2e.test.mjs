/**
 * Scenario: /cursed:setup
 *
 * Verifies that all CLI adapters (cursor-agent, codex) are reachable and
 * authenticated from within a real Claude Code session. This is the cheapest
 * e2e scenario — it probes the local CLIs without making a model call.
 */
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib } from './helpers.mjs';

describe('e2e: /cursed:setup', () => {
  it('reports all adapters as available and authenticated', async () => {
    const session = await startCursedSession('e2e-setup');
    try {
      const events = await runSlash(session.id, '/cursed:setup', { timeoutMs: 60_000 });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool(
        'mcp__plugin_cursed_cursed__setup',
        undefined,
        { wait: false },
      );

      /** @type {import('../../scripts/lib/types.d.ts').AllAdaptersSetupResult | null} */
      const result = /** @type {any} */ (
        extractToolResult(events, 'mcp__plugin_cursed_cursed__setup')
      );

      expect(result.cursor, 'cursor adapter missing from result').toBeDefined();
      expect(result.cursor.available).toBe(true);
      expect(result.cursor.authenticated).toBe(true);
      expect(typeof result.cursor.version).toBe('string');
      expect(result.cursor.errors).toHaveLength(0);

      expect(result.codex, 'codex adapter missing from result').toBeDefined();
      expect(result.codex.available).toBe(true);
      expect(result.codex.authenticated).toBe(true);
      expect(typeof result.codex.version).toBe('string');
      expect(result.codex.errors).toHaveLength(0);
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 90_000);
});

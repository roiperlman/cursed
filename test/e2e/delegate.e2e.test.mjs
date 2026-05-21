/**
 * Scenario: /cursed:delegate --worktree
 *
 * Verifies that delegate runs a task in an isolated worktree and returns a
 * SoloRunResult. Uses --worktree so the test never touches the main working tree
 * (safe to run on a dirty repo). The task is intentionally trivial to keep cost
 * and runtime low.
 *
 * Cost: ~$0.01 (cursor-agent at balanced tier), runtime: ~25–60s.
 */
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib } from './helpers.mjs';

describe('e2e: /cursed:delegate --worktree', () => {
  it('runs a task in an isolated worktree and returns a completed SoloRunResult', async () => {
    const session = await startCursedSession('e2e-delegate');
    try {
      const events = await runSlash(
        session.id,
        '/cursed:delegate "List the top-level files in the repo in a comment at the top of scripts/lib/config.mjs" --worktree e2e-delegate-test',
        { timeoutMs: 300_000 },
      );

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool(
        'mcp__plugin_cursed_cursed__delegate',
        undefined,
        { wait: false },
      );

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (
        extractToolResult(events, 'mcp__plugin_cursed_cursed__delegate')
      );
      expect(result.panel).toBe(false);
      expect(result.command).toBe('delegate');
      expect(result.worktree).not.toBeNull();
      expect(result.worktree.branch).toContain('e2e-delegate-test');
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      expect(typeof result.run.model).toBe('string');
      expect(typeof result.run.duration_ms).toBe('number');
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 360_000);
});

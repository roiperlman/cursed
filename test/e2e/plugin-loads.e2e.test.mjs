/**
 * Scenario: plugin loads
 *
 * Verifies that the cursed MCP server starts and the advise tool returns a
 * structured result. Status may be 'completed' or 'failed' depending on
 * whether cursor-agent is installed — either is acceptable. We are testing
 * the MCP layer, not cursor-agent.
 *
 * Cost: ~$0.005, runtime: ~30–60s.
 */
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib } from './helpers.mjs';

describe('e2e: plugin loads', () => {
  it('cursed MCP server starts and advise tool returns a structured result', async () => {
    const session = await startCursedSession('e2e-plugin-loads');
    try {
      const events = await runSlash(session.id, '/cursed:advise "What is 1+1?"', { timeoutMs: 90_000 });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      expect(result.command).toBe('advise');
      expect(['completed', 'failed']).toContain(result.run.status);
      expect(typeof result.run.model).toBe('string');
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 120_000);
});

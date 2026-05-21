/**
 * Scenario: /cursed:advise
 *
 * Verifies that the advise command routes to a single non-Claude model and returns
 * a structured SoloRunResult with a non-empty text response.
 */
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib } from './helpers.mjs';

describe('e2e: /cursed:advise', () => {
  it('returns a SoloRunResult with non-empty advisor output', async () => {
    const session = await startCursedSession('e2e-advise');
    try {
      const events = await runSlash(
        session.id,
        '/cursed:advise "Should this project use tabs or spaces for indentation?"',
        { timeoutMs: 120_000 },
      );

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      expect(result.command).toBe('advise');
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      expect(typeof result.run.model).toBe('string');
      expect(typeof result.run.duration_ms).toBe('number');
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 150_000);
});

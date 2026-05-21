/**
 * Scenario: /cursed:review (panel mode)
 *
 * Verifies that the 3-model panel runs correctly: all three runs complete,
 * each uses a distinct model (or all fall back to 'auto'), and the result
 * carries the expected PanelResult shape.
 */
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib } from './helpers.mjs';

describe('e2e: /cursed:review (panel)', () => {
  it('runs a 3-model panel and returns a PanelResult with all runs completed', async () => {
    const session = await startCursedSession('e2e-panel-review');
    try {
      const events = await runSlash(session.id, '/cursed:review', { timeoutMs: 300_000 });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__review', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').PanelResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__review'));
      expect(result.panel).toBe(true);
      expect(result.command).toBe('review');
      expect(Array.isArray(result.runs)).toBe(true);

      const completed = result.runs.filter((r) => r.status === 'completed');
      expect(completed.length).toBe(result.runs.length);

      const models = result.runs.map((r) => r.model);
      const uniqueCount = new Set(models).size;
      expect(uniqueCount === models.length || uniqueCount === 1).toBe(true);

      expect(typeof result.summary.models_completed).toBe('number');
      expect(typeof result.summary.total_duration_ms).toBe('number');
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 300_000);

  it('respects --solo flag and returns a completed SoloRunResult', async () => {
    const session = await startCursedSession('e2e-panel-review-solo');
    try {
      const events = await runSlash(session.id, '/cursed:review --solo', { timeoutMs: 360_000 });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__review', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__review'));
      expect(result.panel).toBe(false);
      expect(result.command).toBe('review');
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      expect(typeof result.run.model).toBe('string');
      expect(typeof result.run.duration_ms).toBe('number');
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 420_000);
});

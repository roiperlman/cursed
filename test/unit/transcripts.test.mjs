import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTranscript } from '../../scripts/lib/transcripts.mjs';

/** @typedef {import("../../scripts/lib/types.d.ts").PanelResult} PanelResult */

/**
 * Build a stand-in PanelResult for tests that only assert a subset of fields.
 * Top-level keys are typo-checked against PanelResult; nested values are loose
 * so callers can pass partial RunRecord/RunSummary shapes without ceremony.
 * @param {Partial<Record<keyof PanelResult, unknown>>} overrides
 * @returns {PanelResult}
 */
function partialPanel(overrides) {
  return /** @type {PanelResult} */ (/** @type {unknown} */ (overrides));
}

describe('transcripts', () => {
  it('writes line-by-line with .writeLine and returns the final path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-tr-'));
    try {
      const t = await openTranscript(tmp, {
        command: 'advise',
        model: 'claude-sonnet-4-6',
        now: new Date('2026-04-24T14:23:01Z'),
      });
      await t.writeLine('{"type":"system","subtype":"init","session_id":"cur_1"}');
      await t.writeLine('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}');
      await t.close();

      const raw = await readFile(t.path, 'utf8');
      expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
      expect(t.path).toMatch(/runs\/2026-04-24\/\d{6}-advise-claude-sonnet-4-6\.jsonl$/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates the date-based subdirectory automatically', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-tr-'));
    try {
      await openTranscript(tmp, { command: 'advise', model: 'gpt', now: new Date('2026-01-02T09:05:07Z') });
      const entries = await readdir(join(tmp, 'runs'));
      expect(entries).toContain('2026-01-02');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('writePanelAggregate writes a JSON file at <workspace>/runs/<date>/<HHMMSS>-<command>.panel.json', async () => {
    const { writePanelAggregate } = await import('../../scripts/lib/transcripts.mjs');
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-tr-'));
    try {
      const panelResult = partialPanel({
        panel: true,
        command: 'review',
        runs: [{ model: 'claude-x', status: 'completed', session_id: 'cur_1' }],
        summary: { models_completed: 1, models_failed: 0, errors: [] },
      });
      const path = await writePanelAggregate(tmp, {
        command: 'review',
        panelResult,
        now: new Date('2026-04-24T14:23:01Z'),
      });
      expect(path).toMatch(/runs\/2026-04-24\/142301-review\.panel\.json$/);
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.command).toBe('review');
      expect(parsed.runs[0].model).toBe('claude-x');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('writePanelAggregate creates the date subdirectory automatically', async () => {
    const { writePanelAggregate } = await import('../../scripts/lib/transcripts.mjs');
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-tr-'));
    try {
      await writePanelAggregate(tmp, {
        command: 'review-plan',
        panelResult: partialPanel({ panel: true, command: 'review-plan', runs: [], summary: {} }),
        now: new Date('2026-01-02T09:05:07Z'),
      });
      const entries = await readdir(join(tmp, 'runs'));
      expect(entries).toContain('2026-01-02');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

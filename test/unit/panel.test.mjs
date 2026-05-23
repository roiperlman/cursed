import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPanel } from '../../scripts/lib/panel.mjs';

/** @typedef {import("../../scripts/lib/types.d.ts").RunRecord} RunRecord */
/** @typedef {import("../../scripts/lib/types.d.ts").RunErrorPair} RunErrorPair */
/** @typedef {import("../../scripts/lib/types.d.ts").SoloRunResult} SoloRunResult */
/** @typedef {import("../../scripts/lib/types.d.ts").PanelResult} PanelResult */
/** @typedef {import("../../scripts/lib/types.d.ts").RunTimeouts} RunTimeouts */

/** @type {RunTimeouts} */
const TIMEOUTS = { silence_timeout_seconds: 60, total_timeout_seconds: 600 };

/**
 * @typedef {object} FakeRunInput
 * @property {string} model
 * @property {"completed" | "failed"} [status]
 * @property {string | null} [session_id]
 * @property {RunErrorPair | null} [error]
 */

/**
 * @param {FakeRunInput} input
 * @returns {RunRecord}
 */
function fakeRun({ model, status = 'completed', session_id = `sid-${model}`, error = null }) {
  /** @type {RunRecord} */
  const run = {
    model,
    adapter: 'cursor',
    tier: 'reasoning',
    status,
    session_id,
    text: `text from ${model}`,
    files_changed: [],
    commands_run: [],
    tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
    duration_ms: 1000,
    transcript_path: `/tmp/${model}.jsonl`,
    warnings: [],
    exit_reason: status === 'completed' ? 'completed' : 'stall',
  };
  if (error) run.error = error;
  return run;
}

/**
 * Narrow a runPanel result to PanelResult, throwing if it's the solo shape.
 * @param {SoloRunResult | PanelResult} result
 * @returns {PanelResult}
 */
function asPanel(result) {
  if (!result.panel) throw new Error('expected PanelResult, got SoloRunResult');
  return result;
}

/**
 * Narrow a runPanel result to SoloRunResult, throwing if it's the panel shape.
 * @param {SoloRunResult | PanelResult} result
 * @returns {SoloRunResult}
 */
function asSolo(result) {
  if (result.panel) throw new Error('expected SoloRunResult, got PanelResult');
  return result;
}

describe('panel', () => {
  it('returns SoloRunResult shape when models.length === 1', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) => fakeRun({ model }));
      const result = asSolo(
        await runPanel({
          command: 'advise',
          models: ['claude-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'solo-mode v0.2: tier=reasoning',
          _runOne,
        }),
      );
      expect(result.panel).toBe(false);
      expect(result.command).toBe('advise');
      expect(result.run.model).toBe('claude-x');
      expect(result.run.status).toBe('completed');
      expect(result.selected_reason).toBe('solo-mode v0.2: tier=reasoning');
      expect(result.oc_context).toBeNull();
      expect(_runOne).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns PanelResult with all-success summary when all runs complete', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) => fakeRun({ model }));
      const result = asPanel(
        await runPanel({
          command: 'review',
          models: ['claude-x', 'gpt-x', 'grok-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'panel=3 diverse',
          _runOne,
        }),
      );
      expect(result.panel).toBe(true);
      expect(result.command).toBe('review');
      expect(result.runs).toHaveLength(3);
      expect(result.runs.map((r) => r.model)).toEqual(['claude-x', 'gpt-x', 'grok-x']);
      expect(result.summary.models_completed).toBe(3);
      expect(result.summary.models_failed).toBe(0);
      expect(result.summary.errors).toEqual([]);
      expect(result.summary.total_tokens).toEqual({ input: 30, output: 60, cache_read: 0, cache_write: 0 });
      expect(result.transcript_aggregate_path).toMatch(/runs\/.*\/.*-review\.panel\.json$/);
      expect(_runOne).toHaveBeenCalledTimes(3);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('PanelResult records partial-failure correctly', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) => {
        if (model === 'gpt-x')
          return fakeRun({ model, status: 'failed', error: { code: 'rate_limited', message: 'capped' } });
        return fakeRun({ model });
      });
      const result = asPanel(
        await runPanel({
          command: 'review',
          models: ['claude-x', 'gpt-x', 'grok-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'panel=3',
          _runOne,
        }),
      );
      expect(result.summary.models_completed).toBe(2);
      expect(result.summary.models_failed).toBe(1);
      expect(result.summary.errors).toEqual([{ model: 'gpt-x', code: 'rate_limited', message: 'capped' }]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('PanelResult survives a thrown rejection in one runOne (Promise.allSettled)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) => {
        if (model === 'crashy') throw new Error('boom');
        return fakeRun({ model });
      });
      const result = asPanel(
        await runPanel({
          command: 'review',
          models: ['claude-x', 'crashy', 'grok-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'panel=3',
          _runOne,
        }),
      );
      expect(result.runs).toHaveLength(3);
      const crashed = result.runs.find((r) => r.model === 'crashy');
      expect(crashed?.status).toBe('failed');
      expect(crashed?.error?.code).toBe('internal');
      expect(crashed?.error?.message).toMatch(/boom/);
      expect(result.summary.models_completed).toBe(2);
      expect(result.summary.models_failed).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('writes the panel aggregate JSON to disk and returns the path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) => fakeRun({ model }));
      const result = asPanel(
        await runPanel({
          command: 'review',
          models: ['claude-x', 'gpt-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'panel=2',
          _runOne,
        }),
      );
      if (!result.transcript_aggregate_path) throw new Error('expected aggregate path');
      const raw = await readFile(result.transcript_aggregate_path, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.runs).toHaveLength(2);
      expect(parsed.summary.models_completed).toBe(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('persists state.last_sessions to lowest-indexed completed run', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      // First model fails; second completes — state should pick up second's session_id.
      const _runOne = vi.fn(async ({ model }) => {
        if (model === 'claude-x')
          return fakeRun({ model, status: 'failed', session_id: null, error: { code: 'stall', message: 'no events' } });
        return fakeRun({ model });
      });
      await runPanel({
        command: 'review',
        models: ['claude-x', 'gpt-x', 'grok-x'],
        tier: 'reasoning',
        vars: {},
        resumeLast: false,
        timeouts: TIMEOUTS,
        workspaceDir: tmp,
        selectedReason: 'panel=3',
        _runOne,
      });
      const stateRaw = await readFile(join(tmp, 'state.json'), 'utf8');
      const state = JSON.parse(stateRaw);
      expect(state.last_sessions.review).toBe('sid-gpt-x');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not touch state.last_sessions when every run failed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-panel-'));
    try {
      const _runOne = vi.fn(async ({ model }) =>
        fakeRun({ model, status: 'failed', session_id: null, error: { code: 'stall', message: 'all dead' } }),
      );
      const result = asPanel(
        await runPanel({
          command: 'review',
          models: ['claude-x', 'gpt-x'],
          tier: 'reasoning',
          vars: {},
          resumeLast: false,
          timeouts: TIMEOUTS,
          workspaceDir: tmp,
          selectedReason: 'panel=2',
          _runOne,
        }),
      );
      expect(result.summary.models_completed).toBe(0);
      // state.json is not created when nothing was written
      const entries = await readdir(tmp);
      expect(entries.includes('state.json')).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

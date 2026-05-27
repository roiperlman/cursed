import { describe, it, expect } from 'vitest';
import {
  formatAdapterTag,
  formatRunHeading,
  renderAdapterSummary,
  renderPanel,
  renderSoloRun,
} from '../../scripts/lib/render.mjs';

/** @typedef {import("../../scripts/lib/types.d.ts").PanelResult} PanelResult */
/** @typedef {import("../../scripts/lib/types.d.ts").RunRecord} RunRecord */

/**
 * @param {Partial<RunRecord> & { model: string }} overrides
 * @returns {RunRecord}
 */
function makeRun(overrides) {
  return {
    model: overrides.model,
    adapter: overrides.adapter ?? 'cursor',
    tier: overrides.tier ?? 'balanced',
    status: overrides.status ?? 'completed',
    session_id: overrides.session_id ?? `sid-${overrides.model}`,
    text: overrides.text ?? `findings from ${overrides.model}`,
    files_changed: overrides.files_changed ?? [],
    commands_run: overrides.commands_run ?? [],
    tokens: overrides.tokens ?? { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    duration_ms: overrides.duration_ms ?? 1000,
    transcript_path: overrides.transcript_path ?? `/tmp/${overrides.model}.jsonl`,
    warnings: overrides.warnings ?? [],
    exit_reason: overrides.exit_reason ?? (overrides.status === 'failed' ? 'stall' : 'completed'),
    error: overrides.error,
  };
}

describe('renderSoloRun', () => {
  it('produces the master-design §7.3 solo run shape', () => {
    const out = renderSoloRun({
      command: 'advise',
      model: 'gpt-5.4',
      adapter: 'cursor',
      tier: 'reasoning',
      parsed: {
        session_id: 'cur_1',
        text: 'advice text',
        files_changed: [],
        commands_run: [],
        tokens: { input: 100, output: 50, cache_read: 10, cache_write: 0 },
        duration_ms: 1234,
        errors: [],
        raw_event_count: 5,
      },
      transcriptPath: '/tmp/t.jsonl',
      exitReason: 'completed',
      selectedReason: 'Phase 2 solo-only',
    });
    expect(out.panel).toBe(false);
    expect(out.command).toBe('advise');
    expect(out.run.model).toBe('gpt-5.4');
    expect(out.run.status).toBe('completed');
    expect(out.run.session_id).toBe('cur_1');
    expect(out.run.text).toBe('advice text');
    expect(out.run.tokens.input).toBe(100);
    expect(out.run.transcript_path).toBe('/tmp/t.jsonl');
    expect(out.run.exit_reason).toBe('completed');
    expect(out.selected_reason).toBe('Phase 2 solo-only');
    expect(out.oc_context).toBeNull();
  });

  it('marks status as failed when exitReason is stall', () => {
    const out = renderSoloRun({
      command: 'advise',
      model: 'gpt-5.4',
      adapter: 'cursor',
      tier: 'reasoning',
      parsed: {
        session_id: null,
        text: '',
        files_changed: [],
        commands_run: [],
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        duration_ms: 0,
        errors: [{ code: 'stall', message: 'silence' }],
        raw_event_count: 0,
      },
      transcriptPath: '/tmp/t.jsonl',
      exitReason: 'stall',
      selectedReason: 'x',
    });
    expect(out.run.status).toBe('failed');
    expect(out.run.error).toEqual({ code: 'stall', message: 'silence' });
  });
});

describe('panel render: adapter tags and summary', () => {
  it('formatAdapterTag returns [name] for known adapters', () => {
    expect(formatAdapterTag('cursor')).toBe('[cursor]');
    expect(formatAdapterTag('codex')).toBe('[codex]');
    expect(formatAdapterTag('gemini')).toBe('[gemini]');
    expect(formatAdapterTag('antigravity')).toBe('[antigravity]');
  });

  it('formatAdapterTag returns "" for missing or unknown adapters without throwing', () => {
    expect(formatAdapterTag(undefined)).toBe('');
    expect(formatAdapterTag(null)).toBe('');
    expect(formatAdapterTag('')).toBe('');
    expect(formatAdapterTag('   ')).toBe('');
    // panel.mjs writes the literal "unknown" sentinel when adapterForModel throws.
    expect(formatAdapterTag('unknown')).toBe('');
    expect(formatAdapterTag('made-up-adapter')).toBe('');
  });

  it('formatRunHeading falls back to model id when adapter is missing/unknown', () => {
    expect(formatRunHeading({ model: 'claude-4.6', adapter: 'cursor' })).toBe('claude-4.6 [cursor]');
    expect(formatRunHeading({ model: 'mystery-model', adapter: 'unknown' })).toBe('mystery-model');
    expect(formatRunHeading({ model: 'no-adapter', adapter: '' })).toBe('no-adapter');
  });

  it('renderAdapterSummary groups runs by adapter and preserves first-seen order', () => {
    const runs = [
      makeRun({ model: 'claude-4.6', adapter: 'cursor' }),
      makeRun({ model: 'gemini-2.7', adapter: 'antigravity' }),
      makeRun({ model: 'gpt-5.4', adapter: 'cursor' }),
    ];
    expect(renderAdapterSummary(runs)).toBe(
      'By adapter: 2/3 cursor-routed (claude-4.6, gpt-5.4); 1/3 antigravity-routed (gemini-2.7)',
    );
  });

  it('renderAdapterSummary surfaces an adapter-unknown bucket without leaking the sentinel', () => {
    const runs = [
      makeRun({ model: 'claude-4.6', adapter: 'cursor' }),
      makeRun({ model: 'mystery-model', adapter: 'unknown' }),
    ];
    expect(renderAdapterSummary(runs)).toBe(
      'By adapter: 1/2 cursor-routed (claude-4.6); 1/2 adapter-unknown (mystery-model)',
    );
  });

  it('renderPanel tags each per-model section with [adapter] and emits the adapter summary line', () => {
    /** @type {PanelResult} */
    const panel = {
      panel: true,
      command: 'review',
      runs: [
        makeRun({ model: 'claude-4.6', adapter: 'cursor', text: 'cursor-finding-1' }),
        makeRun({ model: 'gpt-5.4', adapter: 'cursor', text: 'cursor-finding-2' }),
        makeRun({ model: 'gemini-2.7', adapter: 'antigravity', text: 'antigravity-finding' }),
      ],
      summary: {
        models_completed: 3,
        models_failed: 0,
        total_tokens: { input: 3, output: 6, cache_read: 0, cache_write: 0 },
        total_duration_ms: 3000,
        errors: [],
      },
      transcript_aggregate_path: '/tmp/agg.json',
      selected_reason: 'panel=3 tier=balanced diversity=true',
      oc_context: null,
    };
    const out = renderPanel(panel);
    expect(out).toContain('## Panel: review (3 models, 3/3 completed)');
    expect(out).toContain('By adapter: 2/3 cursor-routed (claude-4.6, gpt-5.4); 1/3 antigravity-routed (gemini-2.7)');
    expect(out).toContain('### claude-4.6 [cursor]');
    expect(out).toContain('### gpt-5.4 [cursor]');
    expect(out).toContain('### gemini-2.7 [antigravity]');
    expect(out).toContain('cursor-finding-1');
    expect(out).toContain('antigravity-finding');
    // Order: adapter summary precedes the first per-model heading.
    expect(out.indexOf('By adapter:')).toBeLessThan(out.indexOf('### claude-4.6'));
  });

  it('renderPanel falls back to model id when adapter is missing/unknown — does not throw', () => {
    /** @type {PanelResult} */
    const panel = {
      panel: true,
      command: 'review',
      runs: [
        makeRun({ model: 'claude-4.6', adapter: 'cursor', text: 'A' }),
        // panel.mjs writes the literal "unknown" sentinel for catalog-miss fallbacks.
        makeRun({ model: 'mystery-model', adapter: 'unknown', text: 'B' }),
        // Missing/empty adapter on the wire.
        makeRun({ model: 'no-adapter', adapter: '', text: 'C' }),
      ],
      summary: {
        models_completed: 3,
        models_failed: 0,
        total_tokens: { input: 3, output: 6, cache_read: 0, cache_write: 0 },
        total_duration_ms: 3000,
        errors: [],
      },
      transcript_aggregate_path: '/tmp/agg.json',
      selected_reason: 'panel=3',
      oc_context: null,
    };
    expect(() => renderPanel(panel)).not.toThrow();
    const out = renderPanel(panel);
    expect(out).toContain('### claude-4.6 [cursor]');
    // Fallback: bare model id, no `[unknown]` tag.
    expect(out).toContain('### mystery-model');
    expect(out).not.toContain('mystery-model [');
    expect(out).toContain('### no-adapter');
    expect(out).not.toContain('no-adapter [');
    // Sentinel never leaks into the heading.
    expect(out).not.toContain('[unknown]');
  });

  it('renderPanel surfaces failed-run sections with the error code', () => {
    /** @type {PanelResult} */
    const panel = {
      panel: true,
      command: 'review',
      runs: [
        makeRun({ model: 'claude-4.6', adapter: 'cursor', text: 'ok' }),
        makeRun({
          model: 'gpt-5.4',
          adapter: 'cursor',
          status: 'failed',
          text: '',
          exit_reason: 'stall',
          error: { code: 'stall', message: 'silence timeout' },
        }),
      ],
      summary: {
        models_completed: 1,
        models_failed: 1,
        total_tokens: { input: 2, output: 4, cache_read: 0, cache_write: 0 },
        total_duration_ms: 2000,
        errors: [{ model: 'gpt-5.4', code: 'stall', message: 'silence timeout' }],
      },
      transcript_aggregate_path: '/tmp/agg.json',
      selected_reason: 'panel=2',
      oc_context: null,
    };
    const out = renderPanel(panel);
    expect(out).toContain('## Panel: review (2 models, 1/2 completed)');
    expect(out).toContain('### gpt-5.4 [cursor] — failed (stall: silence timeout)');
    expect(out).toContain('_(no output)_');
  });
});

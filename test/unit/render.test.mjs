import { describe, it, expect } from 'vitest';
import { renderSoloRun } from '../../scripts/lib/render.mjs';

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

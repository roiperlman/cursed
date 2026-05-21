import { describe, it, expect } from 'vitest';
import { streamEventLabel } from '../../../scripts/lib/adapters/codex/parse.mjs';

describe('codex adapter — streamEventLabel', () => {
  it('returns null on empty or whitespace input', () => {
    expect(streamEventLabel('')).toBeNull();
    expect(streamEventLabel('   ')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    expect(streamEventLabel('{not json')).toBeNull();
    expect(streamEventLabel('null')).toBeNull();
    expect(streamEventLabel('42')).toBeNull();
  });

  it('labels thread.started', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }));
    expect(out).toEqual({ kind: 'session_init', label: 'session started' });
  });

  it('labels item.completed with agent_message as assistant', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi' } }),
    );
    expect(out?.kind).toBe('assistant');
  });

  it('labels item.started for tools with the item type in the label', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution' } }),
    );
    expect(out?.kind).toBe('tool_start');
    expect(out?.label).toContain('command_execution');
  });

  it('returns null for item.started on agent_message (only tool starts surface)', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'item.started', item: { id: 'i0', type: 'agent_message' } }));
    expect(out).toBeNull();
  });

  it('labels item.completed for non-message tool result as tool_done', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution' } }),
    );
    expect(out?.kind).toBe('tool_done');
  });

  it('labels turn.completed as result', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'turn.completed', usage: {} }));
    expect(out?.kind).toBe('result');
  });

  it('labels turn.failed and mid-stream error as result_error', () => {
    const out1 = streamEventLabel(JSON.stringify({ type: 'turn.failed', error: { message: 'x' } }));
    expect(out1?.kind).toBe('result_error');
    const out2 = streamEventLabel(JSON.stringify({ type: 'error', message: 'x' }));
    expect(out2?.kind).toBe('result_error');
  });

  it('returns null for unrecognized types (turn.started, future types)', () => {
    expect(streamEventLabel(JSON.stringify({ type: 'turn.started' }))).toBeNull();
    expect(streamEventLabel(JSON.stringify({ type: 'mystery.event' }))).toBeNull();
  });
});

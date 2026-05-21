import { describe, it, expect } from 'vitest';
import { streamEventLabel } from '../../../scripts/lib/adapters/gemini/parse.mjs';

describe('gemini adapter — streamEventLabel', () => {
  it('returns null on empty or whitespace input', () => {
    expect(streamEventLabel('')).toBeNull();
    expect(streamEventLabel('   ')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    expect(streamEventLabel('{not json')).toBeNull();
    expect(streamEventLabel('null')).toBeNull();
    expect(streamEventLabel('42')).toBeNull();
  });

  it('labels init event as session_init', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'init', session_id: 'abc' }));
    expect(out).toEqual({ kind: 'session_init', label: 'session started' });
  });

  it('labels assistant message as assistant', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', delta: true }));
    expect(out?.kind).toBe('assistant');
  });

  it('returns null for user messages', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'message', role: 'user', content: 'hello' }));
    expect(out).toBeNull();
  });

  it('labels tool_use with tool name in label', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'tool_use', tool_name: 'run_shell_command', parameters: { command: 'echo hi' } }),
    );
    expect(out?.kind).toBe('tool_start');
    expect(out?.label).toMatch(/run_shell_command|shell|tool/i);
  });

  it('labels tool_result as tool_done', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'tool_result', tool_id: 'abc' }));
    expect(out).toEqual({ kind: 'tool_done', label: 'tool done' });
  });

  it('labels successful result as result', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'result', status: 'success' }));
    expect(out).toEqual({ kind: 'result', label: 'completed' });
  });

  it('labels failed result as result_error', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'result', status: 'error', error: { message: 'oops' } }));
    expect(out).toEqual({ kind: 'result_error', label: 'agent error' });
  });

  it('labels mid-stream error event as result_error', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'error', severity: 'error', message: 'something failed' }));
    expect(out).toEqual({ kind: 'result_error', label: 'agent error' });
  });

  it('returns null for unknown event types', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'unknown_future_event' }));
    expect(out).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { streamEventLabel } from '../../../scripts/lib/adapters/cursor/parse.mjs';

describe('cursor adapter — streamEventLabel', () => {
  it('returns null on empty or whitespace input', () => {
    expect(streamEventLabel('')).toBeNull();
    expect(streamEventLabel('   ')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    expect(streamEventLabel('{not json')).toBeNull();
    expect(streamEventLabel('null')).toBeNull();
    expect(streamEventLabel('42')).toBeNull();
  });

  it('labels system/init', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }));
    expect(out).toEqual({ kind: 'session_init', label: 'session started' });
  });

  it('labels assistant', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'assistant', message: { content: [] } }));
    expect(out?.kind).toBe('assistant');
  });

  it('labels tool_call/started with the wrapper key in the label', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: {} } }),
    );
    expect(out?.kind).toBe('tool_start');
    expect(out?.label).toContain('shellToolCall');
  });

  it('labels tool_call/completed', () => {
    const out = streamEventLabel(
      JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: {} } }),
    );
    expect(out?.kind).toBe('tool_done');
  });

  it('labels result/success', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 100 }));
    expect(out?.kind).toBe('result');
  });

  it('labels result/error', () => {
    const out = streamEventLabel(JSON.stringify({ type: 'result', subtype: 'error', is_error: true }));
    expect(out?.kind).toBe('result_error');
  });

  it('returns null for unrecognized types (thinking, user echo, etc.)', () => {
    expect(streamEventLabel(JSON.stringify({ type: 'thinking', subtype: 'delta' }))).toBeNull();
    expect(streamEventLabel(JSON.stringify({ type: 'user', subtype: null }))).toBeNull();
  });
});

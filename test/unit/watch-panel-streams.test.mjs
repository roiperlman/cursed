import { describe, it, expect } from 'vitest';
import { extractEvent } from '../../scripts/dev/watch-panel-streams.mjs';

describe('extractEvent — adapter-agnostic stream parser', () => {
  it('returns null for empty/garbage/non-json', () => {
    expect(extractEvent('')).toBeNull();
    expect(extractEvent('not json')).toBeNull();
    expect(extractEvent('{not json')).toBeNull();
    expect(extractEvent('null')).toBeNull();
    expect(extractEvent('"a string"')).toBeNull();
  });

  // cursor-agent shape
  it('cursor: system/init → start', () => {
    expect(extractEvent(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({
      kind: 'start',
    });
  });

  it('cursor: thinking → thinking', () => {
    expect(extractEvent(JSON.stringify({ type: 'thinking', subtype: 'delta' }))).toEqual({
      kind: 'thinking',
    });
  });

  it('cursor: tool_call/started → tool with wrapper key label', () => {
    const out = extractEvent(
      JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: {} } }),
    );
    expect(out).toEqual({ kind: 'tool', label: 'shell' });
  });

  it('cursor: tool_call/completed → tool_done', () => {
    const out = extractEvent(
      JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: {} } }),
    );
    expect(out).toEqual({ kind: 'tool_done' });
  });

  it('cursor: assistant → response with text from content blocks (replace)', () => {
    const out = extractEvent(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: ' world' },
          ],
        },
      }),
    );
    expect(out).toEqual({ kind: 'response', text: 'hello world', append: false });
  });

  it('cursor: result/success with usage → done with tokens', () => {
    const out = extractEvent(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { inputTokens: 100, outputTokens: 42 },
      }),
    );
    expect(out).toEqual({ kind: 'done', ok: true, tokens: { input: 100, output: 42 } });
  });

  // codex shape
  it('codex: thread.started → start', () => {
    expect(extractEvent(JSON.stringify({ type: 'thread.started', thread_id: 'x' }))).toEqual({
      kind: 'start',
    });
  });

  it('codex: item.started command_execution → tool exec', () => {
    const out = extractEvent(
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: '/bin/echo' } }),
    );
    expect(out).toEqual({ kind: 'tool', label: 'exec' });
  });

  it('codex: item.completed agent_message → response with text (append)', () => {
    const out = extractEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
    // codex can emit multiple agent_message items per turn — accumulate.
    expect(out).toEqual({ kind: 'response', text: 'done', append: true });
  });

  it('codex: item.completed command_execution → tool_done', () => {
    const out = extractEvent(
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }),
    );
    expect(out).toEqual({ kind: 'tool_done' });
  });

  it('codex: turn.completed with usage → done with tokens', () => {
    const out = extractEvent(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } }),
    );
    expect(out).toEqual({ kind: 'done', ok: true, tokens: { input: 200, output: 80 } });
  });

  it('codex: turn.failed → error', () => {
    const out = extractEvent(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }));
    expect(out).toEqual({ kind: 'error', message: 'boom' });
  });

  // gemini shape
  it('gemini: init → start', () => {
    expect(extractEvent(JSON.stringify({ type: 'init' }))).toEqual({ kind: 'start' });
  });

  it('gemini: tool_use → tool with tool_name', () => {
    const out = extractEvent(JSON.stringify({ type: 'tool_use', tool_name: 'run_shell_command' }));
    expect(out).toEqual({ kind: 'tool', label: 'run_shell_command' });
  });

  it('gemini: message assistant non-delta → response (replace)', () => {
    const out = extractEvent(JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' }));
    expect(out).toEqual({ kind: 'response', text: 'hi', append: false });
  });

  it('gemini: message assistant delta:true → response (append)', () => {
    const out = extractEvent(JSON.stringify({ type: 'message', role: 'assistant', content: 'chunk', delta: true }));
    expect(out).toEqual({ kind: 'response', text: 'chunk', append: true });
  });

  it('gemini: result with status → done', () => {
    const out = extractEvent(JSON.stringify({ type: 'result', status: 'success' }));
    expect(out).toEqual({ kind: 'done', ok: true, tokens: null });
  });

  // unrecognized
  it('returns null for unknown shapes', () => {
    expect(extractEvent(JSON.stringify({ type: 'unrecognized' }))).toBeNull();
    expect(extractEvent(JSON.stringify({ type: 'user', subtype: null }))).toBeNull();
  });
});

// Adapter-level coverage for codex.parseStream. Exercises the five real
// fixtures under test/fixtures/streams/codex/ end-to-end — locks in
// session_id, text concatenation, tokens (including reasoning), tool
// extraction, file_change discriminator, and error-event handling.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseStream } from '../../../scripts/lib/adapters/codex/parse.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/streams/codex');

/** @param {string} name */
function load(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('codex adapter — parseStream', () => {
  it('returns an empty ParsedRun for empty / null / undefined input', async () => {
    for (const input of ['', null, undefined]) {
      const r = await parseStream(input);
      expect(r.session_id).toBeNull();
      expect(r.text).toBe('');
      expect(r.files_changed).toEqual([]);
      expect(r.commands_run).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.duration_ms).toBe(0); // runOne owns wall-clock duration
    }
  });

  it('parses a minimal agent_message turn (hi-briefly.jsonl)', async () => {
    const r = await parseStream(load('hi-briefly.jsonl'));
    expect(r.session_id).toBe('019e2303-b612-7ef2-838f-1e2113425465');
    expect(r.text).toBe('Hi.');
    expect(r.commands_run).toEqual([]);
    expect(r.files_changed).toEqual([]);
    expect(r.tokens.input).toBe(12601);
    expect(r.tokens.output).toBe(21);
    expect(r.tokens.cache_read).toBe(12160);
    expect(r.tokens.cache_write).toBe(0);
    expect(r.tokens.reasoning).toBe(13);
    expect(r.errors).toEqual([]);
  });

  it('captures shell commands from command_execution items (echo-shell.jsonl)', async () => {
    const r = await parseStream(load('echo-shell.jsonl'));
    expect(r.session_id).toBe('019e2304-0b33-7870-a5fe-f1efc4b89835');
    // Two agent_message items, concatenated in stream order.
    expect(r.text).toBe('I’m running the shell command now and will relay the exact output back.`hello from codex`');
    expect(r.commands_run).toEqual(["/bin/zsh -lc 'echo hello from codex'"]);
    expect(r.files_changed).toEqual([]);
    expect(r.tokens.reasoning).toBe(27);
  });

  it('captures file edits from file_change.changes[].path (file-edit.jsonl)', async () => {
    const r = await parseStream(load('file-edit.jsonl'));
    expect(r.files_changed).toEqual(['/private/tmp/codex-fixture-scratch-x/hello.txt']);
    expect(r.commands_run).toEqual([]);
  });

  it('concatenates multiple agent_messages across a turn in stream order (multi-message.jsonl)', async () => {
    const r = await parseStream(load('multi-message.jsonl'));
    expect(r.text).toContain('I’ll run the two shell commands in order');
    expect(r.text.endsWith('done')).toBe(true);
    expect(r.commands_run).toEqual([
      "/bin/zsh -lc 'echo first'",
      "/bin/zsh -lc 'echo second'",
    ]);
  });

  it('surfaces turn.failed errors with code=internal (error.jsonl)', async () => {
    const r = await parseStream(load('error.jsonl'));
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.every((e) => e.code === 'internal')).toBe(true);
    expect(r.errors.some((e) => /gpt-5-codex/.test(e.message))).toBe(true);
  });

  it('records a parse_error per malformed line and continues', async () => {
    const raw = ['not json', '{"type":"thread.started","thread_id":"x"}'].join('\n');
    const r = await parseStream(raw);
    expect(r.session_id).toBe('x');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('parse_error');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseStream } from '../../../scripts/lib/adapters/gemini/parse.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/streams/gemini');

/** @param {string} name */
function _load(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('gemini adapter — parseStream', () => {
  it('returns an empty ParsedRun for empty / null / undefined input', async () => {
    for (const input of ['', null, undefined]) {
      const r = await parseStream(input);
      expect(r.session_id).toBeNull();
      expect(r.text).toBe('');
      expect(r.files_changed).toEqual([]);
      expect(r.commands_run).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.duration_ms).toBe(0);
    }
  });

  it('records a parse_error per malformed line and continues', async () => {
    const raw = ['{not valid json}', '{"foo":"bar"}'].join('\n');
    const r = await parseStream(raw);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('parse_error');
    expect(r.raw_event_count).toBe(1);
  });

  it('parses a minimal agent_message turn (hi-briefly.jsonl)', async () => {
    const r = await parseStream(_load('hi-briefly.jsonl'));
    expect(r.session_id).toBe('f649bd69-f744-4564-9649-cd3ec66865c0');
    expect(r.text).toBe('Hi! How can I help you today?');
    expect(r.commands_run).toEqual([]);
    expect(r.files_changed).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('captures shell commands from tool_use events (echo-shell.jsonl)', async () => {
    const r = await parseStream(_load('echo-shell.jsonl'));
    expect(r.session_id).toMatch(/.+/);
    expect(r.commands_run.length).toBeGreaterThan(0);
    expect(r.commands_run.some((c) => /echo hello from gemini/.test(c))).toBe(true);
    expect(r.files_changed).toEqual([]);
  });

  it('captures file paths from write_file tool_use events (file-edit.jsonl)', async () => {
    const r = await parseStream(_load('file-edit.jsonl'));
    expect(r.files_changed.length).toBeGreaterThan(0);
    expect(r.files_changed.some((p) => /hello\.txt/.test(p))).toBe(true);
    expect(r.commands_run).toEqual([]);
  });

  it('concatenates multiple agent messages across a turn (multi-message.jsonl)', async () => {
    const r = await parseStream(_load('multi-message.jsonl'));
    expect(r.text).toContain('first');
    expect(r.text).toContain('last');
    expect(r.text.indexOf('first')).toBeLessThan(r.text.indexOf('last'));
    expect(r.commands_run.some((c) => /echo middle/.test(c))).toBe(true);
  });

  it('parses a resumed session (resume.jsonl)', async () => {
    const r = await parseStream(_load('resume.jsonl'));
    expect(r.session_id).toMatch(/.+/);
    expect(r.text.toLowerCase()).toContain('banana');
    expect(r.errors).toEqual([]);
  });

  it('records token usage on the terminal result event (hi-briefly.jsonl)', async () => {
    const r = await parseStream(_load('hi-briefly.jsonl'));
    expect(r.tokens.input).toBeGreaterThan(0);
    expect(r.tokens.output).toBeGreaterThan(0);
    expect(typeof r.tokens.cache_read).toBe('number');
    expect(typeof r.tokens.cache_write).toBe('number');
  });

  it('surfaces terminal errors with code=internal (error.jsonl)', async () => {
    const r = await parseStream(_load('error.jsonl'));
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.every((e) => e.code === 'internal')).toBe(true);
    expect(r.errors.some((e) => /entity was not found|invalid|not found/i.test(e.message))).toBe(true);
  });
});

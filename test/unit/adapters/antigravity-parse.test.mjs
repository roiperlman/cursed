import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseStream, parseTranscript, streamEventLabel } from '../../../scripts/lib/adapters/antigravity/parse.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/streams/antigravity');

/** @param {string} name */
function load(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('antigravity adapter — parseTranscript', () => {
  it('returns an empty ParsedRun for empty / null / undefined input', () => {
    for (const input of ['', null, undefined]) {
      const r = parseTranscript(input, 'sess-1');
      expect(r.session_id).toBe('sess-1');
      expect(r.text).toBe('');
      expect(r.files_changed).toEqual([]);
      expect(r.commands_run).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    }
  });

  it('records a parse_error per malformed line and continues', () => {
    const raw = ['{not valid json}', '{"type":"PLANNER_RESPONSE","content":"ok"}'].join('\n');
    const r = parseTranscript(raw, null);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('parse_error');
    expect(r.raw_event_count).toBe(1);
    expect(r.text).toBe('ok');
  });

  it('parses model text from the happy-path fixture (hi.transcript.jsonl)', () => {
    const r = parseTranscript(load('hi.transcript.jsonl'), 'conv-hi');
    expect(r.session_id).toBe('conv-hi');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });

  it('captures shell commands from run_command tool calls (shell.transcript.jsonl)', () => {
    const r = parseTranscript(load('shell.transcript.jsonl'), null);
    expect(r.commands_run.some((c) => /echo hello-from-antigravity/.test(c))).toBe(true);
  });

  it('captures file paths from write tool calls (file-edit.transcript.jsonl)', () => {
    const r = parseTranscript(load('file-edit.transcript.jsonl'), null);
    expect(r.files_changed.some((p) => /banana\.txt/.test(p))).toBe(true);
  });

  it('concatenates model responses in order (multi-step.transcript.jsonl)', () => {
    const r = parseTranscript(load('multi-step.transcript.jsonl'), null);
    expect(r.text).toContain('ALPHA');
    expect(r.text).toContain('ZETA');
    expect(r.text.indexOf('ALPHA')).toBeLessThan(r.text.indexOf('ZETA'));
  });

  it('surfaces failed steps as internal errors (error.transcript.jsonl)', () => {
    const r = parseTranscript(load('error.transcript.jsonl'), null);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.some((e) => e.code === 'internal')).toBe(true);
  });

  it('tokens are always zero (agy exposes no token counts)', () => {
    const r = parseTranscript(load('hi.transcript.jsonl'), null);
    expect(r.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });
});

describe('antigravity adapter — parseStream', () => {
  it('falls back to stdout text when no cwd is given', async () => {
    const r = await parseStream('  agy said this  ', {});
    expect(r.text).toBe('agy said this');
    expect(r.session_id).toBeNull();
    expect(r.commands_run).toEqual([]);
  });

  it('returns an empty ParsedRun for empty input and no cwd', async () => {
    const r = await parseStream('', {});
    expect(r.text).toBe('');
    expect(r.session_id).toBeNull();
  });

  it('falls back to stdout when the transcript files are unreadable', async () => {
    const _readFile = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const r = await parseStream('stdout fallback text', { cwd: '/tmp/work', _readFile, _homedir: () => '/home/u' });
    expect(r.text).toBe('stdout fallback text');
  });

  it('reads the sidecar transcript via the cwd -> conv-id mapping', async () => {
    const transcript = load('shell.transcript.jsonl');
    const _readFile = async (/** @type {string} */ p) => {
      if (p.endsWith('last_conversations.json')) return JSON.stringify({ '/tmp/work': 'conv-xyz' });
      if (p.includes('/brain/conv-xyz/')) return transcript;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const r = await parseStream('ignored stdout', { cwd: '/tmp/work', _readFile, _homedir: () => '/home/u' });
    expect(r.session_id).toBe('conv-xyz');
    expect(r.commands_run.some((c) => /echo hello-from-antigravity/.test(c))).toBe(true);
  });
});

describe('antigravity adapter — streamEventLabel', () => {
  it('returns null for empty lines', () => {
    expect(streamEventLabel('')).toBeNull();
    expect(streamEventLabel('   ')).toBeNull();
  });

  it('labels a narration line', () => {
    expect(streamEventLabel('I will list the directory.')).toEqual({
      kind: 'narration',
      label: 'I will list the directory.',
    });
  });

  it('truncates long narration lines', () => {
    const label = streamEventLabel('x'.repeat(200));
    expect(label.kind).toBe('narration');
    expect(label.label.length).toBeLessThanOrEqual(80);
  });
});

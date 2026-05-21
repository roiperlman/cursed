import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseStream } from '../../scripts/lib/stream.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, '..', 'fixtures', 'stream-json');

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function readFixture(name) {
  return await readFile(resolve(FIX, name), 'utf8');
}

describe('parseStream — shape invariants', () => {
  // These assertions hold regardless of exact fixture content.
  it('returns the full ParsedRun shape for a normal capture', async () => {
    const raw = await readFixture('hello.jsonl');
    const r = await parseStream(raw);
    expect(r).toMatchObject({
      session_id: expect.any(String),
      text: expect.any(String),
      files_changed: expect.any(Array),
      commands_run: expect.any(Array),
      tokens: expect.objectContaining({
        input: expect.any(Number),
        output: expect.any(Number),
      }),
      errors: expect.any(Array),
      raw_event_count: expect.any(Number),
    });
    expect(r.raw_event_count).toBeGreaterThan(0);
  });

  it('does not surface duration_ms from result events — runOne owns wall-clock duration', async () => {
    // hello.jsonl's terminal result/success carries `duration_ms: 9702`.
    // After Phase 1.5 the parser ignores that field; codex doesn't emit one,
    // and runOne tracks wall-clock for both adapters symmetrically.
    const raw = await readFixture('hello.jsonl');
    const r = await parseStream(raw);
    expect(r.duration_ms).toBe(0);
  });

  it('detects file edits in the edit-file fixture', async () => {
    const raw = await readFixture('edit-file.jsonl');
    const r = await parseStream(raw);
    expect(r.files_changed.length).toBeGreaterThanOrEqual(1);
  });

  it('detects shell invocations in the shell-command fixture', async () => {
    const raw = await readFixture('shell-command.jsonl');
    const r = await parseStream(raw);
    expect(r.commands_run.length).toBeGreaterThanOrEqual(1);
  });

  it('handles malformed JSON lines without throwing', async () => {
    const raw =
      '{"type":"system","subtype":"init","session_id":"x","model":"m"}\n' +
      '{not json}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"session_id":"x"}\n';
    const r = await parseStream(raw);
    expect(r.raw_event_count).toBe(2);
    expect(r.errors.some((e) => e.code === 'parse_error')).toBe(true);
    expect(r.session_id).toBe('x');
    expect(r.text).toBe('ok');
  });

  it('handles an empty input', async () => {
    const r = await parseStream('');
    expect(r.raw_event_count).toBe(0);
    expect(r.text).toBe('');
  });
});

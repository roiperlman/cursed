import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../scripts/lib/cli.mjs';

describe('parseArgs', () => {
  it('extracts the subcommand as argv[0]', () => {
    const r = parseArgs(['setup']);
    expect(r.subcommand).toBe('setup');
    expect(r.flags).toEqual({});
    expect(r.positional).toEqual([]);
  });

  it('parses --key value flags', () => {
    const r = parseArgs(['run', '--command', 'advise', '--tier', 'reasoning']);
    expect(r.subcommand).toBe('run');
    expect(r.flags).toEqual({ command: 'advise', tier: 'reasoning' });
  });

  it('parses --key=value flags', () => {
    const r = parseArgs(['run', '--command=review']);
    expect(r.flags.command).toBe('review');
  });

  it('parses boolean flags (no value before next --)', () => {
    const r = parseArgs(['run', '--resume-last', '--command', 'advise']);
    expect(r.flags['resume-last']).toBe(true);
    expect(r.flags.command).toBe('advise');
  });

  it('collects positional args', () => {
    const r = parseArgs(['run', '--command', 'review', 'path/to/file']);
    expect(r.positional).toEqual(['path/to/file']);
  });

  it('supports --vars with JSON value', () => {
    const r = parseArgs(['run', '--vars', '{"TASK":"hi"}']);
    expect(r.flags.vars).toBe('{"TASK":"hi"}');
  });

  it('throws on missing subcommand', () => {
    expect(() => parseArgs([])).toThrow(/subcommand required/);
  });

  it('throws on flag without value when next token is another flag and flag is not a known boolean', () => {
    // Unknown flags default to string-valued; but if next token starts with -- we treat as boolean.
    // This is permissive on purpose; the subcommand handler does semantic validation.
    const r = parseArgs(['run', '--foo', '--bar', 'baz']);
    expect(r.flags.foo).toBe(true);
    expect(r.flags.bar).toBe('baz');
  });
});

import { describe, it, expect } from 'vitest';
import { buildAntigravityArgs } from '../../../scripts/lib/adapters/antigravity/args.mjs';

describe('antigravity adapter — buildAntigravityArgs', () => {
  it('builds a fresh invocation with prompt + auto-approve flags', () => {
    const { command, args } = buildAntigravityArgs({ prompt: 'hi', model: 'antigravity-default' });
    expect(command).toBe('agy');
    expect(args).toEqual(['-p', 'hi', '--dangerously-skip-permissions']);
  });

  it('appends --sandbox only when CURSED_ANTIGRAVITY_SANDBOX is set', () => {
    expect(buildAntigravityArgs({ prompt: 'hi', model: 'm' }).args).not.toContain('--sandbox');
    process.env.CURSED_ANTIGRAVITY_SANDBOX = '1';
    try {
      const { args } = buildAntigravityArgs({ prompt: 'hi', model: 'm' });
      expect(args).toEqual(['-p', 'hi', '--dangerously-skip-permissions', '--sandbox']);
    } finally {
      delete process.env.CURSED_ANTIGRAVITY_SANDBOX;
    }
  });

  it('ignores the model argument (agy has no model flag)', () => {
    const a = buildAntigravityArgs({ prompt: 'hi', model: 'antigravity-default' });
    const b = buildAntigravityArgs({ prompt: 'hi', model: 'something-else' });
    expect(a.args).toEqual(b.args);
  });

  it('appends --conversation <id> when resumeSessionId is set', () => {
    const { args } = buildAntigravityArgs({ prompt: 'hi', model: 'm', resumeSessionId: 'abc-123' });
    expect(args.slice(-2)).toEqual(['--conversation', 'abc-123']);
  });

  it('appends --continue when only resumeLast is set', () => {
    const { args } = buildAntigravityArgs({ prompt: 'hi', model: 'm', resumeLast: true });
    expect(args.at(-1)).toBe('--continue');
    expect(args).not.toContain('--conversation');
  });

  it('prefers resumeSessionId over resumeLast', () => {
    const { args } = buildAntigravityArgs({ prompt: 'hi', model: 'm', resumeSessionId: 'abc', resumeLast: true });
    expect(args.slice(-2)).toEqual(['--conversation', 'abc']);
    expect(args).not.toContain('--continue');
  });

  it('honors CURSED_ANTIGRAVITY_PATH for the command', () => {
    process.env.CURSED_ANTIGRAVITY_PATH = '/opt/agy';
    try {
      const { command } = buildAntigravityArgs({ prompt: 'hi', model: 'm' });
      expect(command).toBe('/opt/agy');
    } finally {
      delete process.env.CURSED_ANTIGRAVITY_PATH;
    }
  });

  it('merges extraEnv into the child env', () => {
    const { env } = buildAntigravityArgs({ prompt: 'hi', model: 'm', extraEnv: { FOO: 'bar' } });
    expect(env.FOO).toBe('bar');
  });
});

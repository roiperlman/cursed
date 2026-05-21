import { describe, it, expect } from 'vitest';
import { buildCursorArgs } from '../../scripts/lib/cursor.mjs';

describe('buildCursorArgs', () => {
  it('uses print mode, stream-json output, and workspace-trust bypass', () => {
    const { args } = buildCursorArgs({ prompt: 'hi', model: 'gpt-5.4' });
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--force');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4');
  });

  it('passes the prompt as the final positional argument', () => {
    const { args } = buildCursorArgs({ prompt: 'PROMPT TEXT', model: 'gpt-5.4' });
    expect(args[args.length - 1]).toBe('PROMPT TEXT');
  });

  it('appends --resume <id> when resumeSessionId is set', () => {
    const { args } = buildCursorArgs({ prompt: 'hi', model: 'gpt-5.4', resumeSessionId: 'cur_x' });
    const flagIdx = args.indexOf('--resume');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args[flagIdx + 1]).toBe('cur_x');
  });

  it('uses --continue when resumeLast is true (no explicit id)', () => {
    const { args } = buildCursorArgs({ prompt: 'hi', model: 'gpt-5.4', resumeLast: true });
    expect(args).toContain('--continue');
    expect(args).not.toContain('--resume');
  });
});

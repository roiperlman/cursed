import { describe, it, expect } from 'vitest';
import { probeSetup } from '../../../scripts/lib/adapters/antigravity/probe.mjs';

/**
 * @param {Record<string, { stdout: string; stderr?: string; exitCode: number }>} responses
 */
function fakeExec(responses) {
  return async (/** @type {string} */ cmd) => {
    const key = Object.keys(responses).find((k) => cmd.startsWith(k));
    if (!key) throw new Error(`unexpected cmd: ${cmd}`);
    const r = responses[key];
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
}

describe('antigravity adapter — probeSetup', () => {
  it('reports available + version on a successful --version probe', async () => {
    const exec = fakeExec({ 'agy --version': { stdout: '1.0.0\n', exitCode: 0 } });
    const result = await probeSetup({ exec, env: {}, authCheck: async () => true });
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.0.0');
    expect(result.authenticated).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports not_installed on ENOENT', async () => {
    const exec = async () => {
      const e = /** @type {NodeJS.ErrnoException} */ (new Error('ENOENT'));
      e.code = 'ENOENT';
      throw e;
    };
    const result = await probeSetup({ exec, env: {}, authCheck: async () => false });
    expect(result.available).toBe(false);
    expect(result.errors[0].code).toBe('not_installed');
  });

  it('warns (does not error) when auth state is indeterminate', async () => {
    const exec = fakeExec({ 'agy --version': { stdout: '1.0.0\n', exitCode: 0 } });
    const result = await probeSetup({ exec, env: {}, authCheck: async () => false });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('honors CURSED_ANTIGRAVITY_PATH for the version probe', async () => {
    /** @type {string[]} */
    const calls = [];
    const exec = async (/** @type {string} */ cmd) => {
      calls.push(cmd);
      if (cmd === '/opt/agy --version') return { stdout: '1.0.0\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected cmd: ${cmd}`);
    };
    const result = await probeSetup({
      exec,
      env: { CURSED_ANTIGRAVITY_PATH: '/opt/agy' },
      authCheck: async () => true,
    });
    expect(result.available).toBe(true);
    expect(calls).toEqual(['/opt/agy --version']);
  });
});

import { describe, it, expect } from 'vitest';
import geminiAdapter from '../../../scripts/lib/adapters/gemini/index.mjs';

/**
 * @param {Record<string, { stdout: string; stderr?: string; exitCode: number }>} responses
 */
function fakeExec(responses) {
  return async (cmd) => {
    const key = Object.keys(responses).find((k) => cmd.startsWith(k));
    if (!key) throw new Error(`unexpected cmd: ${cmd}`);
    const r = responses[key];
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
}

describe('geminiAdapter.probeSetup', () => {
  it('reports available + version on a successful --version probe', async () => {
    const exec = fakeExec({
      'gemini --version': { stdout: '0.42.0\n', exitCode: 0 },
    });
    const result = await geminiAdapter.probeSetup({
      exec,
      env: { GEMINI_API_KEY: 'x' },
      authCheck: async () => true,
    });
    expect(result.available).toBe(true);
    expect(result.version).toBe('0.42.0');
    expect(result.errors).toEqual([]);
  });

  it('reports not_installed on ENOENT', async () => {
    const exec = async () => {
      const e = /** @type {NodeJS.ErrnoException} */ (new Error('ENOENT'));
      e.code = 'ENOENT';
      throw e;
    };
    const result = await geminiAdapter.probeSetup({ exec, env: {}, authCheck: async () => false });
    expect(result.available).toBe(false);
    expect(result.errors[0].code).toBe('not_installed');
  });

  it.each([
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_API_KEY',
  ])('accepts %s env var as authentication', async (envVarName) => {
    const exec = fakeExec({
      'gemini --version': { stdout: '0.42.0\n', exitCode: 0 },
    });
    const result = await geminiAdapter.probeSetup({
      exec,
      env: { [envVarName]: 'test-value' },
    });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts ~/.gemini/oauth_creds.json existence as authentication', async () => {
    const exec = fakeExec({
      'gemini --version': { stdout: '0.42.0\n', exitCode: 0 },
    });
    const result = await geminiAdapter.probeSetup({
      exec,
      env: {},
      authCheck: async () => true,
    });
    expect(result.authenticated).toBe(true);
  });

  it('reports auth_failed when neither env var nor oauth file is present', async () => {
    const exec = fakeExec({
      'gemini --version': { stdout: '0.42.0\n', exitCode: 0 },
    });
    const result = await geminiAdapter.probeSetup({
      exec,
      env: {},
      authCheck: async () => false,
    });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.errors[0].code).toBe('auth_failed');
  });

  it('honors CURSED_GEMINI_PATH for the version probe', async () => {
    const calls = [];
    const exec = async (cmd) => {
      calls.push(cmd);
      if (cmd === '/opt/gemini --version') return { stdout: '0.42.0\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected cmd: ${cmd}`);
    };
    const result = await geminiAdapter.probeSetup({
      exec,
      env: { CURSED_GEMINI_PATH: '/opt/gemini', GEMINI_API_KEY: 'x' },
    });
    expect(result.available).toBe(true);
    expect(calls).toEqual(['/opt/gemini --version']);
  });
});

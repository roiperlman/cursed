// Adapter-level parity coverage for codex.probeSetup. Same fixture pattern
// as cursor-probe.test.mjs — inject `exec` returning canned stdout for
// `codex --version` and `codex login status`. The codex probe also
// supports CURSED_CODEX_PATH and a Darwin app-bundle fallback; those are
// covered separately.

import { describe, it, expect } from 'vitest';
import codexAdapter from '../../../scripts/lib/adapters/codex/index.mjs';

/**
 * @typedef {{ stdout: string; stderr?: string; exitCode: number }} FakeExecResult
 */

/**
 * @param {Record<string, FakeExecResult>} responses
 * @returns {(cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>}
 */
function fakeExec(responses) {
  return async (cmd) => {
    const key = Object.keys(responses).find((k) => cmd.startsWith(k));
    if (!key) throw new Error(`unexpected cmd: ${cmd}`);
    const r = responses[key];
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
}

describe('codexAdapter.probeSetup', () => {
  it('reports available + authenticated on the happy path', async () => {
    const exec = fakeExec({
      'codex --version': { stdout: 'codex-cli 0.130.0-alpha.5\n', exitCode: 0 },
      'codex login status': { stdout: 'Logged in using ChatGPT\n', exitCode: 0 },
    });
    const result = await codexAdapter.probeSetup({ exec, env: {} });
    expect(result.available).toBe(true);
    expect(result.version).toBe('codex-cli 0.130.0-alpha.5');
    expect(result.authenticated).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts OPENAI_API_KEY env var as authentication', async () => {
    const exec = fakeExec({
      'codex --version': { stdout: 'codex-cli 0.130.0-alpha.5\n', exitCode: 0 },
    });
    const result = await codexAdapter.probeSetup({ exec, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
  });

  it('honors CURSED_CODEX_PATH for both version and auth probes', async () => {
    const calls = /** @type {string[]} */ ([]);
    /** @type {(cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>} */
    const exec = async (cmd) => {
      calls.push(cmd);
      if (cmd === '/opt/codex --version') return { stdout: 'codex-cli 0.130.0-alpha.5\n', stderr: '', exitCode: 0 };
      if (cmd === '/opt/codex login status') return { stdout: 'Logged in using ChatGPT\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected cmd: ${cmd}`);
    };
    const result = await codexAdapter.probeSetup({ exec, env: { CURSED_CODEX_PATH: '/opt/codex' } });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(calls).toEqual(['/opt/codex --version', '/opt/codex login status']);
  });

  it('reports not_installed when codex is missing', async () => {
    /** @type {(cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>} */
    const exec = async () => {
      const e = /** @type {NodeJS.ErrnoException} */ (new Error('ENOENT'));
      e.code = 'ENOENT';
      throw e;
    };
    // Force a non-Darwin codepath by passing an explicit CURSED_CODEX_PATH —
    // that bypasses the app-bundle fallback so the ENOENT propagates cleanly
    // regardless of the host running the test.
    const result = await codexAdapter.probeSetup({ exec, env: { CURSED_CODEX_PATH: '/nope/codex' } });
    expect(result.available).toBe(false);
    expect(result.errors[0].code).toBe('not_installed');
  });

  it('reports auth_failed when no api key and status check is negative', async () => {
    const exec = fakeExec({
      'codex --version': { stdout: 'codex-cli 0.130.0-alpha.5\n', exitCode: 0 },
      'codex login status': { stdout: 'Not logged in\n', exitCode: 1 },
    });
    const result = await codexAdapter.probeSetup({ exec, env: {} });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.errors.some((e) => e.code === 'auth_failed')).toBe(true);
  });
});

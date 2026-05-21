// Adapter-level parity coverage for cursor.probeSetup. The same fixture
// pattern used in test/unit/setup.test.mjs, but importing the cursor
// adapter directly rather than going through the registry-dispatching
// wrapper. Catches the case where the registry path passes through a
// transformation that masks a probe regression.

import { describe, it, expect } from 'vitest';
import cursorAdapter from '../../../scripts/lib/adapters/cursor/index.mjs';

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

describe('cursorAdapter.probeSetup', () => {
  it('reports available + authenticated on the happy path', async () => {
    const exec = fakeExec({
      'cursor-agent --version': { stdout: '2026.04.17-787b533\n', exitCode: 0 },
      'cursor-agent status': { stdout: 'Logged in as alice@example.com\n', exitCode: 0 },
    });
    const result = await cursorAdapter.probeSetup({ exec, env: {} });
    expect(result.available).toBe(true);
    expect(result.version).toBe('2026.04.17-787b533');
    expect(result.authenticated).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts CURSOR_API_KEY env var as authentication', async () => {
    const exec = fakeExec({
      'cursor-agent --version': { stdout: '2026.04.17-787b533\n', exitCode: 0 },
    });
    const result = await cursorAdapter.probeSetup({ exec, env: { CURSOR_API_KEY: 'sk-test' } });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
  });

  it('reports not_installed when cursor-agent is missing', async () => {
    const exec = async () => {
      const e = /** @type {NodeJS.ErrnoException} */ (new Error('ENOENT'));
      e.code = 'ENOENT';
      throw e;
    };
    const result = await cursorAdapter.probeSetup({ exec, env: {} });
    expect(result.available).toBe(false);
    expect(result.errors[0].code).toBe('not_installed');
  });

  it('reports auth_failed when no api key and status check is negative', async () => {
    const exec = fakeExec({
      'cursor-agent --version': { stdout: '2026.04.17-787b533\n', exitCode: 0 },
      'cursor-agent status': { stdout: 'Not logged in\n', exitCode: 1 },
    });
    const result = await cursorAdapter.probeSetup({ exec, env: {} });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.errors.some((e) => e.code === 'auth_failed')).toBe(true);
  });
});

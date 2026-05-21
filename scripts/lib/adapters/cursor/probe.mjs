import { promisify } from 'node:util';
import { exec as cpExec } from 'node:child_process';
import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").SetupResult} SetupResult */

/**
 * @typedef {object} ExecResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 */

/**
 * @typedef {(cmd: string) => Promise<ExecResult>} ExecFn
 */

const defaultExec = promisify(cpExec);

/**
 * @param {string} cmd
 * @returns {Promise<ExecResult>}
 */
async function defaultExecWrapped(cmd) {
  try {
    const { stdout, stderr } = await defaultExec(cmd);
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') throw e;
    const errAny = /** @type {{ stdout?: string; stderr?: string; code?: number | string }} */ (e);
    return {
      stdout: errAny.stdout ?? '',
      stderr: errAny.stderr ?? '',
      exitCode: typeof errAny.code === 'number' ? errAny.code : 1,
    };
  }
}

/**
 * @typedef {object} AuthCheckArgs
 * @property {ExecFn} exec
 * @property {NodeJS.ProcessEnv} env
 */

/**
 * @typedef {(args: AuthCheckArgs) => Promise<boolean>} AuthCheckFn
 */

/**
 * Auth probe (Phase 0 Q5 answered):
 *  1. CURSOR_API_KEY env var — accept as authenticated (cursor-agent honors it via --api-key).
 *  2. Otherwise: shell out to `cursor-agent status`. Exit 0 with stdout containing "Logged in"
 *     (or the equivalent affirmative string) → authenticated via Keychain / `cursor login`.
 *     Non-zero or "Not logged in" → unauthenticated.
 *
 * Note: on Darwin, `cursor login` stores tokens in the macOS Keychain (service
 * `cursor-access-token`, account `cursor-user`). The Cursor IDE's vscdb is a
 * SEPARATE store — the CLI does not read from it.
 *
 * @type {AuthCheckFn}
 */
async function defaultAuthCheck({ exec, env }) {
  if (env.CURSOR_API_KEY) return true;
  try {
    const { stdout, exitCode } = await exec('cursor-agent status');
    if (exitCode === 0 && /logged in/i.test(stdout || '')) return true;
  } catch {
    // fall through
  }
  return false;
}

/**
 * @typedef {object} ProbeSetupOptions
 * @property {ExecFn} [exec]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {AuthCheckFn} [authCheck]
 */

/**
 * Probe the local cursor-agent install for availability + auth, returning a SetupResult.
 *
 * @param {ProbeSetupOptions} [options]
 * @returns {Promise<SetupResult>}
 */
export async function probeSetup({ exec = defaultExecWrapped, env = process.env, authCheck = defaultAuthCheck } = {}) {
  /** @type {SetupResult} */
  const result = {
    available: false,
    version: null,
    authenticated: false,
    default_model: null,
    providers_reachable: [],
    warnings: [],
    errors: [],
  };

  /** @type {ExecResult | undefined} */
  let versionOut;
  try {
    versionOut = await exec('cursor-agent --version');
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      result.errors.push(makeError('not_installed', 'cursor-agent not found on PATH'));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError('internal', `version probe failed: ${message}`));
    return result;
  }

  // Exit code 0 required — shell "command not found" (127) and runtime errors
  // both return non-zero without throwing ENOENT from the exec wrapper.
  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError('not_installed', 'cursor-agent not found on PATH'));
    return result;
  }

  result.available = true;
  result.version = (versionOut.stdout || '').trim().split('\n')[0] || null;

  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError('auth_failed', 'no CURSOR_API_KEY and `cursor-agent status` does not report a logged-in session'),
    );
  }

  return result;
}

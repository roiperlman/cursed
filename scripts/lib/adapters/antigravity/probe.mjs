import { promisify } from 'node:util';
import { exec as cpExec } from 'node:child_process';
import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").SetupResult} SetupResult */
/** @typedef {import("../../types.d.ts").ProbeExecResult} ProbeExecResult */
/** @typedef {import("../../types.d.ts").ProbeSetupOptions} ProbeSetupOptions */

const defaultExec = promisify(cpExec);

/**
 * @param {string} cmd
 * @returns {Promise<ProbeExecResult>}
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
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveAntigravityCommand(env) {
  return env.CURSED_ANTIGRAVITY_PATH || 'agy';
}

/**
 * Best-effort auth check. `agy` persists its OAuth token in the macOS keychain
 * as a generic-password item (service `gemini`, account `antigravity`) — see
 * `.cursed/antigravity-discovery.md`. There is no API-key env var and no
 * `whoami`-style command. On non-macOS hosts, or if the keychain lookup fails,
 * this returns false and `probeSetup` surfaces a warning, never a hard error.
 *
 * @param {{ exec: import("../../types.d.ts").ProbeExecFn }} args
 * @returns {Promise<boolean>}
 */
async function defaultAuthCheck({ exec }) {
  try {
    const r = await exec('security find-generic-password -s gemini -a antigravity');
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Probe the local `agy` CLI for availability + auth.
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

  const bin = resolveAntigravityCommand(env);

  /** @type {ProbeExecResult | undefined} */
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      result.errors.push(makeError('not_installed', `agy not found (looked for ${bin})`));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError('internal', `version probe failed: ${message}`));
    return result;
  }

  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError('not_installed', `agy --version exited ${versionOut.exitCode}`));
    return result;
  }

  result.available = true;
  result.version = (versionOut.stdout || '').trim().split('\n')[0] || null;

  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.warnings.push(
      'antigravity auth state could not be determined non-interactively; run `agy` once to sign in if runs fail with an auth error',
    );
  }

  return result;
}

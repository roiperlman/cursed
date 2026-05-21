import { promisify } from 'node:util';
import { exec as cpExec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").SetupResult} SetupResult */
/** @typedef {import("../../types.d.ts").ProbeExecResult} ProbeExecResult */
/** @typedef {import("../../types.d.ts").ProbeExecFn} ProbeExecFn */
/** @typedef {import("../../types.d.ts").ProbeAuthCheckFn} ProbeAuthCheckFn */
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
function resolveGeminiCommand(env) {
  return env.CURSED_GEMINI_PATH || 'gemini';
}

const OAUTH_CREDS_PATH = join(homedir(), '.gemini', 'oauth_creds.json');

/**
 * @param {{ env: NodeJS.ProcessEnv }} args
 * @returns {Promise<boolean>}
 */
async function defaultAuthCheck({ env }) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_API_KEY) return true;
  if (existsSync(OAUTH_CREDS_PATH)) return true;
  return false;
}

/**
 * Probe the local gemini CLI for availability + auth.
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

  const bin = resolveGeminiCommand(env);

  /** @type {ProbeExecResult | undefined} */
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      result.errors.push(makeError('not_installed', `gemini not found (looked for ${bin})`));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError('internal', `version probe failed: ${message}`));
    return result;
  }

  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError('not_installed', `gemini --version exited ${versionOut.exitCode}`));
    return result;
  }

  result.available = true;
  result.version = (versionOut.stdout || '').trim().split('\n')[0] || null;

  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError(
        'auth_failed',
        'no GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY env var and ~/.gemini/oauth_creds.json not present',
      ),
    );
  }

  return result;
}

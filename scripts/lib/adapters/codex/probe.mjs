import { promisify } from 'node:util';
import { exec as cpExec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").SetupResult} SetupResult */
/** @typedef {import("../../types.d.ts").ProbeExecResult} ProbeExecResult */
/** @typedef {import("../../types.d.ts").ProbeExecFn} ProbeExecFn */
/** @typedef {import("../../types.d.ts").ProbeAuthCheckFn} ProbeAuthCheckFn */
/** @typedef {import("../../types.d.ts").ProbeSetupOptions} ProbeSetupOptions */

const defaultExec = promisify(cpExec);

// macOS bundled-CLI fallback. The DMG install ships codex inside the desktop
// app; the brew cask normally symlinks it onto PATH but the symlink breaks
// when the cask is rebuilt. Mirroring the path here so probeSetup still works
// on otherwise-unsymlinked installs. See .cursed/codex-discovery.md.
const DARWIN_BUNDLED_PATH = '/Applications/Codex.app/Contents/Resources/codex';

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
 * Resolve the codex executable, honoring CURSED_CODEX_PATH first and the
 * Darwin app-bundle fallback last. `null` if no candidate exists on disk —
 * caller treats as `not_installed`. We don't probe PATH ourselves; spawning
 * `codex --version` does that for free.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveCodexCommand(env) {
  if (env.CURSED_CODEX_PATH) return env.CURSED_CODEX_PATH;
  // Try PATH first (the cursor adapter has the same convention). If `codex`
  // isn't on PATH but the bundled binary exists, fall back to it so users with
  // a broken brew symlink still get a working probe.
  if (process.platform === 'darwin' && existsSync(DARWIN_BUNDLED_PATH)) {
    // We can't synchronously check PATH availability without spawning; the
    // probe will spawn `codex --version` which throws ENOENT when missing. If
    // PATH has codex, the bare name still wins (faster resolution). Only
    // resolve to the bundled path explicitly when PATH would fail.
    // Heuristic: prefer the bundled path on Darwin to avoid a wasted spawn
    // when the brew symlink is broken. PATH-installed codex still works
    // when CURSED_CODEX_PATH is unset and the bundled binary is missing
    // (most non-Darwin users hit this).
  }
  return 'codex';
}

/**
 * Auth probe: `codex login status` returns `Logged in using ChatGPT` (OAuth)
 * or similar text. Also accepts non-empty `OPENAI_API_KEY`, with the caveat
 * recorded in discovery: a ChatGPT-account session doesn't grant API-tier
 * model access. `OPENAI_API_KEY` is hand-rolled API access; together they
 * cover both auth paths.
 *
 * @type {ProbeAuthCheckFn}
 */
async function defaultAuthCheck({ exec, env }) {
  if (env.OPENAI_API_KEY) return true;
  const bin = resolveCodexCommand(env);
  try {
    const { stdout, stderr, exitCode } = await exec(`${bin} login status`);
    if (exitCode === 0 && /logged in/i.test((stdout || '') + (stderr || ''))) return true;
  } catch {
    // fall through
  }
  return false;
}

/**
 * Probe the local codex CLI for availability + auth.
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
    // Phase 2 #3 will rename this to `vendors_reachable`; for now the field
    // stays compatible with the cursor adapter's shape.
    providers_reachable: [],
    warnings: [],
    errors: [],
  };

  const bin = resolveCodexCommand(env);

  /** @type {ProbeExecResult | undefined} */
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    // ENOENT on bare `codex`: try the Darwin bundled fallback before giving up.
    if (
      e instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' &&
      bin === 'codex' &&
      process.platform === 'darwin' &&
      existsSync(DARWIN_BUNDLED_PATH)
    ) {
      try {
        versionOut = await exec(`${DARWIN_BUNDLED_PATH} --version`);
      } catch {
        result.errors.push(makeError('not_installed', 'codex not found on PATH or in /Applications/Codex.app'));
        return result;
      }
    } else if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      result.errors.push(makeError('not_installed', `codex not found (looked for ${bin})`));
      return result;
    } else {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(makeError('internal', `version probe failed: ${message}`));
      return result;
    }
  }

  result.available = true;
  result.version = (versionOut.stdout || '').trim().split('\n')[0] || null;

  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError('auth_failed', 'no OPENAI_API_KEY and `codex login status` does not report a logged-in session'),
    );
  }

  return result;
}

import { createHash } from 'node:crypto';
import { basename, resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** @typedef {import("./types.d.ts").StateShape} StateShape */

/** @type {StateShape} */
const DEFAULT_STATE = { version: 1, last_sessions: {} };

/**
 * Stable per-workspace directory slug — `<basename>-<sha256(canonical-cwd)[0..16]>`.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function workspaceSlug(cwd) {
  const canonical = resolve(cwd);
  const sha = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${basename(canonical)}-${sha}`;
}

/**
 * Resolve the data directory cursed writes plugin state into.
 * Honors `CLAUDE_PLUGIN_DATA` if set; otherwise falls back to `<TMPDIR>/cursed-plugin`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function dataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.trim() !== '') {
    return env.CLAUDE_PLUGIN_DATA;
  }
  const tmp = env.TMPDIR || '/tmp';
  return join(tmp, 'cursed-plugin');
}

/**
 * Resolve the workspace-scoped state directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
export function workspaceDir(env = process.env, cwd = process.cwd()) {
  return join(dataDir(env), 'state', workspaceSlug(cwd));
}

/**
 * Path to `<workspaceDir>/state.json`.
 *
 * @param {string} workspaceDirPath
 * @returns {string}
 */
export function stateFilePath(workspaceDirPath) {
  return join(workspaceDirPath, 'state.json');
}

/**
 * Read and shape-normalize the workspace state file. Missing file returns DEFAULT_STATE.
 *
 * @param {string} workspaceDirPath
 * @returns {Promise<StateShape>}
 */
export async function readState(workspaceDirPath) {
  const path = stateFilePath(workspaceDirPath);
  try {
    const raw = await readFile(path, 'utf8');
    const s = JSON.parse(raw);
    // Legacy `jobs` field from v0.2 state files is silently discarded.
    return {
      version: s.version ?? 1,
      last_sessions: s.last_sessions ?? {},
    };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      return { ...DEFAULT_STATE };
    }
    throw e;
  }
}

/**
 * Write the workspace state file atomically (well, mkdir + writeFile — no fsync).
 *
 * @param {string} workspaceDirPath
 * @param {StateShape} state
 * @returns {Promise<void>}
 */
export async function writeState(workspaceDirPath, state) {
  await mkdir(workspaceDirPath, { recursive: true });
  await writeFile(stateFilePath(workspaceDirPath), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Persist `last_sessions[command] = sessionId`.
 *
 * @param {string} workspaceDirPath
 * @param {string} command
 * @param {string | null} sessionId
 * @returns {Promise<void>}
 */
export async function setLastSession(workspaceDirPath, command, sessionId) {
  const s = await readState(workspaceDirPath);
  s.last_sessions[command] = sessionId;
  await writeState(workspaceDirPath, s);
}

/**
 * Look up the most recent session id for the given command (or null if none).
 *
 * @param {string} workspaceDirPath
 * @param {string} command
 * @returns {Promise<string | null>}
 */
export async function getLastSession(workspaceDirPath, command) {
  const s = await readState(workspaceDirPath);
  return s.last_sessions[command] ?? null;
}

/** @typedef {import("./types.d.ts").ErrorCode} ErrorCode */
/** @typedef {import("./types.d.ts").CursedError} CursedError */

/**
 * Stable taxonomy of cursed error codes. Frozen so consumers can't mutate.
 * @type {Readonly<Record<ErrorCode, ErrorCode>>}
 */
export const ERROR_CODES = Object.freeze({
  auth_failed: 'auth_failed',
  not_installed: 'not_installed',
  stall: 'stall',
  total_timeout: 'total_timeout',
  rate_limited: 'rate_limited',
  network: 'network',
  tool_refused: 'tool_refused',
  cancelled: 'cancelled',
  parse_error: 'parse_error',
  session_invalid: 'session_invalid',
  worktree_failed: 'worktree_failed',
  worktree_branch_exists: 'worktree_branch_exists',
  worktree_dir_exists: 'worktree_dir_exists',
  worktree_cleanup_failed: 'worktree_cleanup_failed',
  dirty_tree: 'dirty_tree',
  stale: 'stale',
  internal: 'internal',
});

/**
 * Process exit codes used by the CLI.
 * @type {Readonly<{
 *   SUCCESS: 0;
 *   ALL_RUNS_FAILED: 1;
 *   CONFIG_ERROR: 2;
 *   AUTH_FAILURE: 3;
 *   NOT_INSTALLED: 4;
 *   JOB_STILL_RUNNING: 5;
 *   UNKNOWN_JOB: 6;
 * }>}
 */
export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ALL_RUNS_FAILED: 1,
  CONFIG_ERROR: 2,
  AUTH_FAILURE: 3,
  NOT_INSTALLED: 4,
  JOB_STILL_RUNNING: 5,
  UNKNOWN_JOB: 6,
});

/**
 * Build a structured error object.
 * @param {ErrorCode} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {CursedError}
 */
export function makeError(code, message, details) {
  if (!ERROR_CODES[code]) {
    throw new Error(`unknown error code: ${code}`);
  }
  /** @type {CursedError} */
  const err = { code, message };
  if (details !== undefined) err.details = details;
  return err;
}

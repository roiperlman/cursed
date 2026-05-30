import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/**
 * @typedef {object} DiffStat
 * @property {number} files_changed
 * @property {number} insertions
 * @property {number} deletions
 * @property {number} loc_touched
 * @property {string[]} file_paths
 * @property {string} [error] - Present only when the underlying git invocation failed.
 */

/**
 * Run `git diff --stat <target>` and parse the result.
 *
 * @param {string} [target] - Diff target ref expression. Defaults to `main...HEAD`.
 * @param {string} [cwd] - Working directory. Defaults to `process.cwd()`.
 * @returns {Promise<DiffStat>}
 */
export async function diffStat(target = 'main...HEAD', cwd = process.cwd()) {
  try {
    const { stdout } = await pexec('git', ['diff', '--stat', target], { cwd });
    return parseDiffStat(stdout);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { files_changed: 0, loc_touched: 0, insertions: 0, deletions: 0, file_paths: [], error: message };
  }
}

/**
 * Resolve `HEAD` to a 40-char SHA via `git rev-parse`.
 *
 * @param {string} [cwd] - Working directory. Defaults to `process.cwd()`.
 * @returns {Promise<string>}
 */
export async function revParseHead(cwd = process.cwd()) {
  const { stdout } = await pexec('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

/**
 * Parse the textual output of `git diff --stat` into a DiffStat record.
 *
 * @param {string} raw
 * @returns {DiffStat}
 */
export function parseDiffStat(raw) {
  if (!raw?.trim()) {
    return { files_changed: 0, loc_touched: 0, insertions: 0, deletions: 0, file_paths: [] };
  }
  const lines = raw.split('\n').filter(Boolean);
  const summary = lines[lines.length - 1] || '';
  /** @type {string[]} */
  const files = [];
  for (const line of lines.slice(0, -1)) {
    const m = line.match(/^\s*([^|]+?)\s+\|/);
    if (m) files.push(m[1].trim());
  }
  const summaryMatch = summary.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  );
  const files_changed = summaryMatch ? parseInt(summaryMatch[1], 10) : files.length;
  const insertions = summaryMatch?.[2] ? parseInt(summaryMatch[2], 10) : 0;
  const deletions = summaryMatch?.[3] ? parseInt(summaryMatch[3], 10) : 0;
  return {
    files_changed,
    insertions,
    deletions,
    loc_touched: insertions + deletions,
    file_paths: files,
  };
}

/**
 * @typedef {object} DiffResolveResult
 * @property {string} stdout - Raw diff output (may be empty when the diff is empty).
 * @property {string} stderr - Stderr from git, or '' on success.
 * @property {number} exitCode - 0 when git ran cleanly; non-zero when it failed.
 * @property {string | null} error - Single-line error description when `exitCode !== 0`, else null.
 */

/**
 * Resolve a `git diff` invocation for review SCOPE inlining.
 *
 * - `path` set → `git diff -- <path>` (target is ignored to match the
 *   review handler's "path wins over target" semantics, mirroring
 *   `buildReviewScope`).
 * - `path` unset → `git diff <target>` (default target `main...HEAD`).
 *
 * Captures stdout and stderr separately and never throws — failures are
 * reported via `exitCode`/`error` so the caller can surface them in SCOPE
 * and the run log without aborting the panel run (acceptance criterion #5
 * in ROI-69).
 *
 * Buffer is bumped to 256 MB so a multi-hundred-MB diff doesn't trip
 * `MAXBUFFER` before the truncation helper has a chance to head+tail it.
 *
 * @param {{ target?: string, path?: string, cwd?: string }} [opts]
 * @returns {Promise<DiffResolveResult>}
 */
export async function resolveReviewDiff(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const args = opts.path ? ['diff', '--', opts.path] : ['diff', opts.target ?? 'main...HEAD'];
  try {
    const { stdout, stderr } = await pexec('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, error: null };
  } catch (e) {
    const err = /** @type {{ stdout?: string, stderr?: string, code?: number, message?: string }} */ (
      /** @type {unknown} */ (e ?? {})
    );
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const exitCode = typeof err.code === 'number' && err.code !== 0 ? err.code : 1;
    const message =
      (stderr && stderr.split('\n').find((l) => l.trim().length > 0)) ||
      (typeof err.message === 'string' ? err.message.split('\n')[0] : 'git diff failed');
    return { stdout, stderr, exitCode, error: message.trim() };
  }
}

/**
 * List untracked files via `git ls-files --others --exclude-standard`.
 * `--exclude-standard` honors `.gitignore`, `.git/info/exclude`, and the
 * user's global excludes — so paths the user has intentionally hidden
 * from git stay hidden from review SCOPE.
 *
 * Returns an empty array (not an error) when:
 *  - the tree has no untracked files; or
 *  - `cwd` is not a git repository (git exits non-zero). Review SCOPE
 *    construction must not fail just because the user is outside a repo —
 *    the diff-based scope already swallows that case in `diffStat`.
 *
 * @param {string} [cwd] - Working directory. Defaults to `process.cwd()`.
 * @returns {Promise<string[]>}
 */
export async function gitListUntrackedFiles(cwd = process.cwd()) {
  try {
    const { stdout } = await pexec('git', ['ls-files', '--others', '--exclude-standard'], { cwd });
    return stdout.split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Run `git status --porcelain` and report cleanliness.
 *
 * @param {string} [cwd] - Working directory. Defaults to `process.cwd()`.
 * @returns {Promise<{ clean: boolean, lines: string[] }>}
 */
export async function gitStatusPorcelain(cwd = process.cwd()) {
  const { stdout } = await pexec('git', ['status', '--porcelain'], { cwd });
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  return { clean: lines.length === 0, lines };
}

/**
 * Verify a ref resolves and return its SHA. Throws on unknown refs.
 *
 * @param {string} ref
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function gitRevParse(ref, cwd = process.cwd()) {
  const { stdout } = await pexec('git', ['rev-parse', '--verify', ref], { cwd });
  return stdout.trim();
}

/**
 * Check whether a local branch exists.
 *
 * @param {string} name - branch name
 * @param {string} [cwd]
 * @returns {Promise<boolean>}
 */
export async function gitBranchExists(name, cwd = process.cwd()) {
  try {
    await pexec('git', ['rev-parse', '--verify', `refs/heads/${name}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a new git worktree at `path` on a fresh branch forked from `base`.
 *
 * @param {object} input
 * @param {string} input.path - target directory for the new worktree
 * @param {string} input.branch - new branch name to create
 * @param {string} input.base - ref to fork from
 * @param {string} [input.cwd] - main repo working directory. Defaults to `process.cwd()`.
 * @returns {Promise<void>}
 */
export async function gitWorktreeAdd({ path, branch, base, cwd = process.cwd() }) {
  await pexec('git', ['worktree', 'add', path, '-b', branch, base], { cwd });
}

/**
 * Remove a worktree at `path` (passes `--force`; uncommitted changes inside the worktree are discarded).
 *
 * @param {string} path - worktree path to remove
 * @param {string} [cwd] - main repo working directory
 * @returns {Promise<void>}
 */
export async function gitWorktreeRemove(path, cwd = process.cwd()) {
  await pexec('git', ['worktree', 'remove', '--force', path], { cwd });
}

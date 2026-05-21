import { join, resolve, sep } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { gitWorktreeAdd, gitWorktreeRemove, gitBranchExists, gitRevParse, gitStatusPorcelain } from './git.mjs';
import { makeError } from './errors.mjs';

/**
 * Convention: cursed-created worktrees live under `<repoRoot>/.cursed/worktrees/`.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function worktreeRoot(repoRoot) {
  return join(repoRoot, '.cursed', 'worktrees');
}

/**
 * Idempotently ensure `<repoRoot>/.gitignore` contains `line`. No-op if the
 * file does not exist (we never create `.gitignore` ourselves) or if the line
 * is already present (exact-match on a trimmed line).
 *
 * @param {string} repoRoot
 * @param {string} line - e.g. `.cursed/`
 * @returns {Promise<void>}
 */
export async function ensureGitignoreLine(repoRoot, line) {
  const path = join(repoRoot, '.gitignore');
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
    throw err;
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(line)) return;
  const sep = content.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${content}${sep}${line}\n`, 'utf8');
}

/**
 * @typedef {object} CreateWorktreeInput
 * @property {string} name - branch name (also used for the on-disk dir name)
 * @property {string} base - ref to fork from (e.g. "HEAD" or "main")
 * @property {string} repoRoot - main repo working directory
 */

/**
 * @typedef {object} CreateWorktreeResult
 * @property {string} path - absolute path to the new worktree dir
 * @property {string} branch - the new branch name
 * @property {string} base - resolved SHA of the base ref
 */

/**
 * Create a fresh worktree at `<repoRoot>/.cursed/worktrees/<name>` on a fresh
 * branch `<name>` forked from `<base>`.
 *
 * Throws structured `CursedError`s with codes:
 *   - `worktree_branch_exists` — branch is already present
 *   - `worktree_dir_exists`    — target directory already exists
 *   - `worktree_failed`        — git operation failed (incl. unresolvable base)
 *
 * @param {CreateWorktreeInput} input
 * @returns {Promise<CreateWorktreeResult>}
 */
export async function createWorktree({ name, base, repoRoot }) {
  // Path-traversal guard: reject names that resolve outside .cursed/worktrees/
  // (e.g. "../foo", absolute paths, or anything that escapes via "..").
  // Branch names with slashes (e.g. "feat/auth") remain allowed — the resolved
  // path is what matters, not the literal characters.
  const root = worktreeRoot(repoRoot);
  const candidate = resolve(join(root, name));
  const safeRoot = resolve(root);
  if (candidate !== safeRoot && !candidate.startsWith(safeRoot + sep)) {
    throw makeError('worktree_failed', `invalid worktree name "${name}": resolves outside ${root}`);
  }

  // Resolve the base ref first — gives a clean error before we touch anything.
  let baseSha;
  try {
    baseSha = await gitRevParse(base, repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw makeError('worktree_failed', `cannot resolve base ref "${base}": ${msg}`);
  }

  if (await gitBranchExists(name, repoRoot)) {
    throw makeError('worktree_branch_exists', `branch "${name}" already exists`);
  }

  const wtPath = candidate;
  let dirExists = false;
  try {
    await stat(wtPath);
    dirExists = true;
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  if (dirExists) {
    throw makeError('worktree_dir_exists', `worktree directory "${wtPath}" already exists`);
  }

  try {
    await gitWorktreeAdd({ path: wtPath, branch: name, base, cwd: repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw makeError('worktree_failed', `git worktree add failed: ${msg}`);
  }

  await ensureGitignoreLine(repoRoot, '.cursed/');

  return { path: wtPath, branch: name, base: baseSha };
}

/**
 * Remove a worktree previously created by `createWorktree`. Branch is preserved.
 *
 * @param {object} input
 * @param {string} input.path
 * @param {string} input.repoRoot
 * @returns {Promise<void>}
 */
export async function removeWorktree({ path, repoRoot }) {
  await gitWorktreeRemove(path, repoRoot);
}

/**
 * Render a worktree path relative to the repo root.
 * Falls back to the absolute path if it doesn't sit under repoRoot.
 *
 * @param {string} path
 * @param {string} repoRoot
 * @returns {string}
 */
export function relativeFromRepoRoot(path, repoRoot) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, '') : path;
}

/** @typedef {import("./types.d.ts").WorktreeCleanupStatus} WorktreeCleanupStatus */
/** @typedef {import("./types.d.ts").WorktreeInfo} WorktreeInfo */

/**
 * @typedef {object} WorktreePostFlightInput
 * @property {{ path: string, branch: string, base: string }} worktreeInfo
 * @property {"completed" | "failed"} runStatus
 * @property {boolean} keep
 * @property {string} repoRoot
 */

/**
 * @typedef {object} WorktreePostFlightResult
 * @property {WorktreeCleanupStatus} cleanup_status
 * @property {string[]} warnings
 * @property {string[]} followup_commands
 */

/**
 * Run the post-flight that v0.3 #1 added inline to the MCP delegate handler.
 * Extracted in v0.3 #2 so the background worker can call the same logic without
 * importing from `scripts/mcp/cursed-mcp.mjs`.
 *
 *   - completed + !keep + clean worktree → `git worktree remove`; cleanup_status="removed"
 *   - completed + keep                   → cleanup_status="kept-on-success"
 *   - completed + !keep + uncommitted    → cleanup_status="kept-cleanup-failed" + warning
 *   - failed (any keep)                  → cleanup_status="kept-due-to-failure"
 *   - `git worktree remove` throws       → cleanup_status="kept-cleanup-failed" + warning
 *
 * @param {WorktreePostFlightInput} input
 * @returns {Promise<WorktreePostFlightResult>}
 */
export async function runWorktreePostFlight({ worktreeInfo, runStatus, keep, repoRoot }) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {WorktreeCleanupStatus} */
  let cleanup_status;

  const wantCleanup = runStatus === 'completed' && keep !== true;
  if (wantCleanup) {
    const wtStatus = await gitStatusPorcelain(worktreeInfo.path).catch(() => ({
      clean: true,
      lines: /** @type {string[]} */ ([]),
    }));
    if (!wtStatus.clean) {
      warnings.push(
        `worktree_uncommitted_output: model finished with ${wtStatus.lines.length} uncommitted entries in ${worktreeInfo.path}; worktree retained — inspect with \`cd ${worktreeInfo.path} && git status\``,
      );
      cleanup_status = 'kept-cleanup-failed';
    } else {
      try {
        await removeWorktree({ path: worktreeInfo.path, repoRoot });
        cleanup_status = 'removed';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`worktree_cleanup_failed: ${msg}; worktree retained at ${worktreeInfo.path}`);
        cleanup_status = 'kept-cleanup-failed';
      }
    }
  } else if (runStatus === 'completed') {
    cleanup_status = 'kept-on-success';
  } else {
    cleanup_status = 'kept-due-to-failure';
  }

  const wtRel = relativeFromRepoRoot(worktreeInfo.path, repoRoot);
  const followup_commands = [
    `git diff ${worktreeInfo.base}..${worktreeInfo.branch}`,
    `git merge ${worktreeInfo.branch}`,
    ...(cleanup_status === 'removed' ? [] : [`git worktree remove ${wtRel}`]),
    `git branch -d ${worktreeInfo.branch}`,
  ];

  return { cleanup_status, warnings, followup_commands };
}

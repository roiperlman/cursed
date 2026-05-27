import { join } from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {object} ActiveRunMeta
 * @property {string} id
 * @property {string} command   - 'review' | 'advise' | 'plan-review' | 'delegate'
 * @property {string} model
 * @property {string} tier
 * @property {number} pid        - Process owning the run (MCP server pid for sync MCP calls)
 * @property {string} started_at - ISO timestamp
 * @property {string} [transcript_path]
 */

/**
 * @param {string} workspaceDir
 * @returns {string}
 */
export function activeRunsDir(workspaceDir) {
  return join(workspaceDir, 'active-runs');
}

/**
 * @returns {string} 16-hex-char run id.
 */
export function generateActiveRunId() {
  return randomBytes(8).toString('hex');
}

/**
 * Default liveness probe: signal 0 doesn't deliver, it only checks permission.
 * Returns true when the process exists (even if we can't signal it), false on
 * ESRCH (no such process). Any other error path also returns false — better to
 * drop a stale entry than to keep a phantom alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    return code === 'EPERM';
  }
}

/**
 * Write `<workspaceDir>/active-runs/<id>.json`. Best-effort: caller should
 * `.catch(() => {})` so a registry failure can never abort a real run.
 *
 * @param {string} workspaceDir
 * @param {ActiveRunMeta} meta
 * @returns {Promise<string>} Path written.
 */
export async function registerActiveRun(workspaceDir, meta) {
  const dir = activeRunsDir(workspaceDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${meta.id}.json`);
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Best-effort delete. Missing file is not an error.
 *
 * @param {string} workspaceDir
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function unregisterActiveRun(workspaceDir, id) {
  await rm(join(activeRunsDir(workspaceDir), `${id}.json`), { force: true });
}

/**
 * List active runs in the workspace, filtering out entries whose owning pid is
 * no longer alive. Stale entries are removed from disk on the way out — this
 * is the recovery path for MCP server crashes that would otherwise strand
 * registry files indefinitely.
 *
 * @param {string} workspaceDir
 * @param {{ isPidAlive?: (pid: number) => boolean }} [opts]
 * @returns {Promise<ActiveRunMeta[]>}
 */
export async function listActiveRuns(workspaceDir, opts = {}) {
  const probe = opts.isPidAlive ?? isPidAlive;
  const dir = activeRunsDir(workspaceDir);
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  /** @type {ActiveRunMeta[]} */
  const live = [];
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    const path = join(dir, fname);
    /** @type {ActiveRunMeta | null} */
    let meta = null;
    try {
      const raw = await readFile(path, 'utf8');
      meta = JSON.parse(raw);
    } catch {
      // unreadable / corrupt — drop it
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (!meta || typeof meta.pid !== 'number' || !probe(meta.pid)) {
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    live.push(meta);
  }
  // Newest first.
  live.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return live;
}

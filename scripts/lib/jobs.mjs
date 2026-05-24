import { dirname, join } from 'node:path';
import { open, mkdir, readFile, readdir, rename, rm, stat, access } from 'node:fs/promises';
import { adapterForModel } from './adapters/registry.mjs';

/** @typedef {import("./types.d.ts").JobMeta} JobMeta */
/** @typedef {import("./types.d.ts").JobStatusRecord} JobStatusRecord */
/** @typedef {import("./types.d.ts").SoloRunResult} SoloRunResult */

/**
 * Wall-clock budget for the 'completing' phase (between `_runOne` returning
 * and the worker writing the terminal status). Long enough to cover any
 * realistic post-flight on a slow disk; short enough that an OOM/SIGKILL'd
 * worker in 'completing' doesn't strand the job indefinitely. (Gemini's
 * panel-review pushback against giving `'completing'` infinite TTL.)
 */
export const COMPLETING_TTL_MS = 120_000;

/** @param {string} workspaceDir */
export function jobsDir(workspaceDir) {
  return join(workspaceDir, 'jobs');
}

/**
 * Treat `running` and `completing` as live (not-yet-terminal). Used by CLI
 * commands that have to gate on "is this job still in motion?" without caring
 * which sub-phase it's in. `completing` is the short window between
 * `_runOne` returning and the worker writing the terminal status.
 *
 * @param {import("./types.d.ts").JobStatus} status
 * @returns {boolean}
 */
export function isJobLive(status) {
  return status === 'running' || status === 'completing';
}

/**
 * Wall-clock deadline (ms epoch) past which a live job is considered stale.
 * Shared by `readJob` (stale-synthesis gate) and `createJobState` (id-reuse
 * gate) so the two paths can't disagree about what "still in motion" means.
 *
 * Anchoring:
 *   - `running`     → `started_at + total_timeout + 60s grace`
 *   - `completing`  → `completing_at + COMPLETING_TTL_MS` if completing_at
 *                     parseable; else `started_at + running_ttl + COMPLETING_TTL_MS`
 *                     (worst-case upper bound for a worker that flipped to
 *                     completing without writing completing_at — e.g. an old
 *                     status.json from before F8 landed).
 *
 * Returns `0` when meta lacks a finite anchor (callers treat that as
 * already-past-deadline → immediately stale).
 *
 * @param {JobMeta} meta
 * @param {JobStatusRecord} status
 * @returns {number}
 */
function liveDeadlineMs(meta, status) {
  // P2: a `completing` job with a valid `completing_at` is anchored solely
  // by that timestamp + COMPLETING_TTL_MS. The `started_at` anchor is
  // irrelevant for this case — even if `meta.started_at` is unparseable
  // (corrupted meta.json after a partial write, e.g. the F8 window), we
  // still have ground truth about when the worker entered the
  // `completing` phase. Short-circuiting to 0 here would falsely mark the
  // job stale and let `createJobState` clobber its dir mid-completion.
  if (status.status === 'completing' && status.completing_at) {
    const completingAtMs = Date.parse(status.completing_at);
    if (Number.isFinite(completingAtMs)) return completingAtMs + COMPLETING_TTL_MS;
  }
  const startedMs = Date.parse(meta.started_at);
  if (!Number.isFinite(startedMs)) return 0;
  const totalTimeoutMs = Number.isFinite(meta.total_timeout_seconds) ? meta.total_timeout_seconds * 1000 : 0;
  const runningDeadlineMs = startedMs + totalTimeoutMs + 60_000;
  if (status.status !== 'completing') return runningDeadlineMs;
  // F10: status.json from a worker that flipped to 'completing' before the
  // F8 schema landed (no completing_at). Fall back to the worst-case bound
  // so a fresh-completing job isn't treated as expired the instant it flips.
  return runningDeadlineMs + COMPLETING_TTL_MS;
}

/**
 * Is the job "still in motion" — both nominally live (running/completing)
 * AND inside its live-window? gpt-5.4 panel-review-3 follow-up: pre-fix,
 * createJobState used `now < deadlineMs` and readJob used `now > deadlineMs`,
 * which disagreed at the exact-tick boundary `now === deadlineMs`. This
 * helper centralizes the comparison so the two paths can never drift apart.
 *
 * Boundary convention: at `now === deadlineMs` we treat the job as
 * no-longer-in-motion (returns false). Both callers therefore agree to
 * treat the boundary as "expired / safe to reuse / synthesize stale."
 *
 * @param {JobMeta} meta
 * @param {JobStatusRecord} status
 * @param {number} now
 * @returns {boolean}
 */
function isWithinLiveWindow(meta, status, now) {
  if (!isJobLive(status.status)) return false;
  const deadlineMs = liveDeadlineMs(meta, status);
  return deadlineMs > 0 && now < deadlineMs;
}

/** @param {string} workspaceDir @param {string} id */
export function jobStateDir(workspaceDir, id) {
  return join(jobsDir(workspaceDir), id);
}

/**
 * Process-local counter that, combined with `process.hrtime.bigint()`, makes
 * `atomicWrite` tmp filenames collision-free even under same-tick concurrent
 * calls within a single process (F15). Pre-F15 the tmp name was
 * `${target}.tmp.${pid}.${Date.now()}` — Date.now() has ms resolution, so two
 * concurrent atomicWrite calls in the same ms produced identical tmp paths,
 * letting B truncate A's open file before A's rename. The counter alone is
 * sufficient for in-process uniqueness; hrtime adds inter-burst entropy.
 *
 * @type {bigint}
 */
let atomicWriteCounter = 0n;

/**
 * Atomic write via tmp+rename, with best-effort fsyncs on the tmp file
 * before rename AND on the parent directory after rename. Without the file
 * fsync, a power-loss between rename() and the filesystem flushing the new
 * inode could leave the target empty or with stale content. Without the
 * parent-dir fsync (F13), rename's directory-entry update can be lost on
 * power-loss even though the inode itself was flushed — POSIX says rename
 * is atomic for in-memory state but doesn't promise durability of the
 * directory entry without an explicit fsync of the parent dir.
 *
 * Both fsyncs are best-effort: some filesystems (tmpfs, certain Windows
 * configs) reject directory fsync or file fsync entirely. We never block
 * durability on either.
 *
 * @param {string} target
 * @param {string} content
 * @returns {Promise<void>}
 */
async function atomicWrite(target, content) {
  const tmp = `${target}.tmp.${process.pid}.${process.hrtime.bigint()}.${atomicWriteCounter++}`;
  /** @type {import('node:fs/promises').FileHandle | null} */
  let fh = null;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(content, 'utf8');
    try {
      await fh.sync();
    } catch {
      /* fsync unsupported on some filesystems / tmpfs — best-effort only */
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  await rename(tmp, target);
  // F13: fsync the parent directory so the new directory entry survives
  // power loss. Best-effort — not all filesystems allow opening a dir for
  // sync (notably Windows; some FUSE backends). Failures are silent.
  try {
    const dirFh = await open(dirname(target), 'r');
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close().catch(() => {});
    }
  } catch {
    /* directory fsync unsupported — best-effort only */
  }
}

/**
 * Known per-run artifacts cleared when a job id is reused. Excludes meta.json
 * and status.json (both rewritten unconditionally below) and `worker.stderr`
 * (recreated by the spawn handler when the bonus stderr fd is enabled).
 */
const STALE_JOB_ARTIFACTS = ['result.json', 'cancel.marker', 'cursor.stdout', 'cursor.stderr', 'worker.stderr'];

/**
 * Create the job state dir and write meta.json + initial status.json.
 *
 * Concurrency contract (Grok G4 + Gemini M4 + F10 + F11): if the directory
 * already exists with a live status.json ('running' or 'completing') AND the
 * job is still within its live-deadline window, refuse — there's a plausible
 * zombie worker that may still be writing into this slot, and silently
 * clobbering its artifacts could corrupt the new job. The caller (typically
 * /cursed:forget) must clean up first.
 *
 * F11: result.json presence is NOT proof of termination — the worker writes
 * result.json before flipping status.json to a terminal state, so there's a
 * brief window where result.json exists while the worker is still alive.
 * Gate purely on `isJobLive(status) && withinTtl` (the TTL itself bounds the
 * window). The artifact-cleanup step below still runs once we accept reuse.
 *
 * Allowed paths:
 *   - dir doesn't exist                  → fresh create.
 *   - status='completed|failed|cancelled' → terminal; safe to clean-slate.
 *   - prior meta past TTL                → presumed dead; safe to clean-slate.
 *   - status.json absent / unreadable    → no live-worker evidence; allow.
 *   - meta.json unreadable               → no TTL evidence; allow (gc-mtime
 *                                          fallback in gcWorkspaceJobs handles
 *                                          truly-stranded dirs).
 *
 * Always-cleared artifacts on accepted reuse: result.json, cancel.marker,
 * cursor.std{out,err}, worker.stderr. Without this clean-slate a leftover
 * `cancel.marker` would self-cancel the new worker.
 *
 * @param {{ workspaceDir: string, id: string, meta: JobMeta, now?: number }} input
 * @returns {Promise<{ state_dir: string, stdoutPath: string, stderrPath: string }>}
 */
export async function createJobState({ workspaceDir, id, meta, now = Date.now() }) {
  const state_dir = jobStateDir(workspaceDir, id);
  /** @type {boolean} */
  let dirExisted;
  try {
    const st = await stat(state_dir);
    dirExisted = st.isDirectory();
  } catch {
    dirExisted = false;
  }
  if (dirExisted) {
    /** @type {JobStatusRecord | null} */
    let priorStatus = null;
    try {
      priorStatus = JSON.parse(await readFile(join(state_dir, 'status.json'), 'utf8'));
    } catch {
      /* unreadable status: treat as no live-worker evidence */
    }
    /** @type {JobMeta | null} */
    let priorMeta = null;
    try {
      priorMeta = JSON.parse(await readFile(join(state_dir, 'meta.json'), 'utf8'));
    } catch {
      /* unreadable meta: treat as no TTL evidence */
    }

    if (priorStatus && priorMeta && isWithinLiveWindow(priorMeta, priorStatus, now)) {
      const err = new Error(
        `job_id_in_use: prior job at ${state_dir} is still ${priorStatus.status} within its TTL; run /cursed:cancel ${id} or /cursed:forget ${id} before reusing this id`,
      );
      // @ts-expect-error — attach a stable code for callers
      err.code = 'job_id_in_use';
      throw err;
    }
  }

  await mkdir(state_dir, { recursive: true });
  for (const name of STALE_JOB_ARTIFACTS) {
    await rm(join(state_dir, name), { force: true });
  }
  await atomicWrite(join(state_dir, 'meta.json'), JSON.stringify(meta, null, 2));
  await atomicWrite(
    join(state_dir, 'status.json'),
    JSON.stringify({ status: 'running', started_at: meta.started_at }, null, 2),
  );
  return {
    state_dir,
    stdoutPath: join(state_dir, 'cursor.stdout'),
    stderrPath: join(state_dir, 'cursor.stderr'),
  };
}

/** @param {string} state_dir @param {JobStatusRecord} status */
export async function writeStatus(state_dir, status) {
  await atomicWrite(join(state_dir, 'status.json'), JSON.stringify(status, null, 2));
}

/**
 * Write result.json if absent. Uses a check-then-write pattern that is NOT
 * fully atomic — two concurrent callers could both pass the existence check
 * before either renames. Under the single-writer-per-job architecture (one
 * worker per state_dir, plus rare synthesizer calls from readers) this is
 * accepted as low risk. Callers that need strict overwrite protection should
 * coordinate externally.
 *
 * @param {string} state_dir
 * @param {SoloRunResult} result
 * @returns {Promise<{ wrote: boolean }>}
 */
export async function writeResult(state_dir, result) {
  try {
    await access(join(state_dir, 'result.json'));
    return { wrote: false };
  } catch {
    /* file absent → write */
  }
  await atomicWrite(join(state_dir, 'result.json'), JSON.stringify(result, null, 2));
  return { wrote: true };
}

/** @param {string} state_dir */
export async function writeCancelMarker(state_dir) {
  const target = join(state_dir, 'cancel.marker');
  try {
    await access(target);
    return; // already marked — preserve first-cancel timestamp
  } catch {
    /* absent → write */
  }
  await atomicWrite(target, new Date().toISOString());
}

/** @param {string} state_dir @returns {Promise<boolean>} */
export async function cancelMarkerExists(state_dir) {
  try {
    await access(join(state_dir, 'cancel.marker'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Synthesize a terminal "stale" result for a job that's `running` past TTL.
 * Refuses to overwrite an existing result.json. Updates status.json to failed.
 *
 * Note: synthesized `followup_commands` use the absolute `meta.worktree.path`
 * because the read APIs (`readJob`, `listJobs`, `gcWorkspaceJobs`) don't carry
 * `repoRoot`. The foreground handler and worker both render relative paths via
 * `relativeFromRepoRoot`. A stale job's followup commands are still copy-pastable
 * but look different from other cursed output. Accepted tradeoff vs. threading
 * `repoRoot` through every read path.
 *
 * @param {{ state_dir: string, meta: JobMeta, now: number }} input
 * @returns {Promise<{ status: JobStatusRecord, result: SoloRunResult, synthesized: boolean, warning?: string }>}
 */
export async function synthesizeStale({ state_dir, meta, now }) {
  const finished_at = new Date(now).toISOString();
  let adapterName = 'unknown';
  try {
    adapterName = (await adapterForModel(meta.model)).name;
  } catch {
    // adapterForModel falls back to cursor when no catalog matches.
  }
  /** @type {SoloRunResult} */
  const synth = {
    panel: false,
    command: meta.command,
    run: {
      model: meta.model,
      adapter: adapterName,
      tier: meta.tier,
      status: 'failed',
      session_id: null,
      text: '',
      files_changed: [],
      commands_run: [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      duration_ms: Number.isFinite(Date.parse(meta.started_at)) ? now - Date.parse(meta.started_at) : 0,
      transcript_path: null,
      exit_reason: 'stale',
      warnings: [],
      error: {
        code: 'stale',
        message: `worker exceeded total_timeout (${meta.total_timeout_seconds}s) + grace; no result.json on disk`,
      },
    },
    selected_reason: `background-stale: TTL elapsed at ${finished_at}`,
    oc_context: null,
    worktree: {
      path: meta.worktree.path,
      branch: meta.worktree.branch,
      base: meta.worktree.base,
      cleanup_status: 'kept-due-to-failure',
      followup_commands: [
        `git diff ${meta.worktree.base}..${meta.worktree.branch}`,
        `git merge ${meta.worktree.branch}`,
        `git worktree remove ${meta.worktree.path}`,
        `git branch -d ${meta.worktree.branch}`,
      ],
    },
  };
  const wrote = (await writeResult(state_dir, synth)).wrote;
  /** @type {SoloRunResult} */
  const finalResult = wrote ? synth : JSON.parse(await readFile(join(state_dir, 'result.json'), 'utf8'));
  /** @type {JobStatusRecord} */
  const status = { status: 'failed', started_at: meta.started_at, finished_at };
  // Best-effort: if writeStatus fails (disk full, permissions) status.json
  // stays 'running'/'completing' and the in-memory return below reflects
  // disk reality so callers don't get a phantom 'failed' that disagrees
  // with `ls jobs/<id>/status.json`. The synthesized result.json IS
  // already on disk (writeResult ran first), so /cursed:result will at
  // least surface the stale failure even though status.json is wedged.
  try {
    await writeStatus(state_dir, status);
    return { status, result: finalResult, synthesized: wrote };
  } catch (e) {
    /** @type {JobStatusRecord} */
    let onDiskStatus;
    try {
      onDiskStatus = JSON.parse(await readFile(join(state_dir, 'status.json'), 'utf8'));
    } catch {
      onDiskStatus = { status: 'running', started_at: meta.started_at };
    }
    const warning = `synthesizeStale: writeStatus failed at ${state_dir} (status.json stuck at ${onDiskStatus.status}): ${e instanceof Error ? e.message : String(e)}`;
    return { status: onDiskStatus, result: finalResult, synthesized: wrote, warning };
  }
}

/**
 * Read a job's meta + status, synthesizing-and-persisting stale terminal state
 * if the job is `running` past TTL. Reads result.json if it exists.
 *
 * @param {string} state_dir
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ meta: JobMeta, status: JobStatusRecord, result?: SoloRunResult, warning?: string }>}
 */
export async function readJob(state_dir, opts = {}) {
  const now = opts.now ?? Date.now();
  /** @type {JobMeta} */
  let meta;
  try {
    meta = JSON.parse(await readFile(join(state_dir, 'meta.json'), 'utf8'));
  } catch (e) {
    throw new Error(`unreadable meta.json at ${state_dir}: ${e instanceof Error ? e.message : String(e)}`);
  }

  /** @type {JobStatusRecord} */
  let status;
  /** @type {string | undefined} */
  let warning;
  try {
    status = JSON.parse(await readFile(join(state_dir, 'status.json'), 'utf8'));
  } catch (e) {
    warning = `unreadable status.json at ${state_dir}: ${e instanceof Error ? e.message : String(e)}`;
    status = { status: 'failed', started_at: meta.started_at, finished_at: new Date(now).toISOString() };
  }

  if (isJobLive(status.status)) {
    // Shared predicate (F10 + gpt-5.4 follow-up): readJob and createJobState
    // use the same comparison so they can't disagree about what counts as
    // a live job. Pre-fix the two callers used `now > deadlineMs` vs
    // `now < deadlineMs`, which disagreed at the exact-tick boundary.
    const isStale = !isWithinLiveWindow(meta, status, now);
    if (isStale) {
      const synth = await synthesizeStale({ state_dir, meta, now });
      // Chain synthesizeStale's status-write failure into the caller-visible
      // warning. Without this, repeated readJob calls silently re-synthesize.
      const mergedWarning = [warning, synth.warning].filter(Boolean).join('; ') || undefined;
      return { meta, status: synth.status, result: synth.result, warning: mergedWarning };
    }
  }

  /** @type {SoloRunResult | undefined} */
  let result;
  try {
    result = JSON.parse(await readFile(join(state_dir, 'result.json'), 'utf8'));
  } catch {
    /* no result.json yet — fine for running, suspicious for terminal */
  }
  return { meta, status, result, warning };
}

/**
 * List all jobs under workspaceDir. Tolerates corrupt entries via per-entry `warning`.
 *
 * @param {string} workspaceDir
 * @param {{ now?: number }} [opts]
 * @returns {Promise<Array<{ id: string, state_dir: string, meta: JobMeta, status: JobStatusRecord, result?: SoloRunResult, warning?: string }>>}
 */
export async function listJobs(workspaceDir, opts = {}) {
  const dir = jobsDir(workspaceDir);
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
  /** @type {Array<{ id: string, state_dir: string, meta: JobMeta, status: JobStatusRecord, result?: SoloRunResult, warning?: string }>} */
  const out = [];
  for (const name of entries) {
    const state_dir = join(dir, name);
    try {
      const st = await stat(state_dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const job = await readJob(state_dir, opts);
      out.push({ id: name, state_dir, ...job });
    } catch (e) {
      out.push({
        id: name,
        state_dir,
        // @ts-expect-error — synthesizing a partial record for an unreadable job
        meta: undefined,
        // @ts-expect-error
        status: undefined,
        warning: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * GC: delete terminal/stale job dirs whose anchor (finished_at, else
 * started_at + total_timeout) is older than retentionDays.
 *
 * F14: when `readJob` throws (typically because meta.json is corrupt or
 * absent — F1 writes a terminal status.json in that state but readJob still
 * insists on parseable meta), fall back to `fs.stat(state_dir).mtime` as the
 * anchor. The reason for an unreadable-meta state IS corruption; an
 * mtime-based fallback is the right semantic. Without this fallback an
 * unreadable-meta dir strands on disk forever — F1's terminal status flip
 * never gets a chance to influence GC because gc never reaches the rm step.
 *
 * Never touches worktrees. Best-effort; per-job errors collected in `warnings`.
 *
 * @param {string} workspaceDir
 * @param {{ retentionDays: number, now: number }} opts
 * @returns {Promise<{ scanned: number, deleted: string[], warnings: string[] }>}
 */
export async function gcWorkspaceJobs(workspaceDir, { retentionDays, now }) {
  const cutoff = now - retentionDays * 24 * 3600 * 1000;
  /** @type {{ scanned: number, deleted: string[], warnings: string[] }} */
  const r = { scanned: 0, deleted: [], warnings: [] };
  const dir = jobsDir(workspaceDir);
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return r;
    r.warnings.push(`readdir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return r;
  }
  for (const name of entries) {
    const state_dir = join(dir, name);
    /** @type {import('node:fs').Stats} */
    let dirStat;
    try {
      dirStat = await stat(state_dir);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    r.scanned++;
    try {
      const job = await readJob(state_dir, { now });
      /** @type {number} */
      let anchor;
      if (isJobLive(job.status.status)) {
        const totalTimeoutMs = Number.isFinite(job.meta.total_timeout_seconds)
          ? job.meta.total_timeout_seconds * 1000
          : 0;
        anchor = Date.parse(job.meta.started_at) + totalTimeoutMs;
      } else if (job.result?.run?.exit_reason === 'stale') {
        // Bug-fix (ROI-4): readJob synthesized this job's stale terminal state
        // in this same call, stamping `finished_at = now`. Anchoring on that
        // fresh timestamp would extend retention by a full `retention_days`
        // window for every stale-running job cleaned up via GC. Anchor on the
        // original live-deadline (started_at + total_timeout) — the moment
        // the job became observably dead — so eligible-for-deletion takes
        // effect on the same pass that synthesizes the stale state.
        const totalTimeoutMs = Number.isFinite(job.meta.total_timeout_seconds)
          ? job.meta.total_timeout_seconds * 1000
          : 0;
        const startedMs = Date.parse(job.meta.started_at);
        anchor = Number.isFinite(startedMs) ? startedMs + totalTimeoutMs : 0;
      } else if (job.status.finished_at) {
        anchor = Date.parse(job.status.finished_at);
      } else {
        anchor = Date.parse(job.meta.started_at);
      }
      if (anchor < cutoff) {
        await rm(state_dir, { recursive: true, force: true });
        r.deleted.push(name);
      }
    } catch (e) {
      // F14: readJob failed (typically unreadable meta.json). Fall back to
      // the state_dir mtime — if older than cutoff, GC the dir so corrupted
      // entries don't strand forever. Record the warning either way so the
      // user has visibility into the underlying corruption.
      const warning = `${name}: ${e instanceof Error ? e.message : String(e)}`;
      const mtimeMs = dirStat.mtime.getTime();
      if (Number.isFinite(mtimeMs) && mtimeMs < cutoff) {
        try {
          await rm(state_dir, { recursive: true, force: true });
          r.deleted.push(name);
          r.warnings.push(`${warning} (gc'd by mtime fallback)`);
        } catch (rmErr) {
          r.warnings.push(
            `${warning}; mtime-fallback rm failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
          );
        }
      } else {
        r.warnings.push(warning);
      }
    }
  }
  return r;
}

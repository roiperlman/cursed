#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne as defaultRunOne } from './lib/run.mjs';
import { writeStatus, writeResult, cancelMarkerExists } from './lib/jobs.mjs';
import { runWorktreePostFlight, relativeFromRepoRoot } from './lib/worktree.mjs';

/** @typedef {import("./lib/types.d.ts").JobMeta} JobMeta */
/** @typedef {import("./lib/types.d.ts").SoloRunResult} SoloRunResult */
/** @typedef {import("./lib/types.d.ts").RunRecord} RunRecord */
/** @typedef {import("./lib/types.d.ts").WorktreeCleanupStatus} WorktreeCleanupStatus */

/**
 * Build a SoloRunResult from a RunRecord + post-flight info. Mirrors the
 * shape returned by the foreground delegate handler so callers see one wire
 * format across foreground and background.
 *
 * @param {{ run: RunRecord, command: import('./lib/types.d.ts').CommandName, meta: JobMeta, postFlight: { cleanup_status: WorktreeCleanupStatus, followup_commands: string[], warnings: string[] }, repoRoot: string }} input
 * @returns {SoloRunResult}
 */
function buildResult({ run, command, meta, postFlight, repoRoot }) {
  run.warnings = [...run.warnings, ...postFlight.warnings];
  const wtRel = relativeFromRepoRoot(meta.worktree.path, repoRoot);
  return {
    panel: false,
    command,
    run,
    selected_reason: `background-worker: tier=${meta.tier}, model=${meta.model}`,
    oc_context: null,
    worktree: {
      path: wtRel,
      branch: meta.worktree.branch,
      base: meta.worktree.base,
      cleanup_status: postFlight.cleanup_status,
      followup_commands: postFlight.followup_commands,
    },
  };
}

/**
 * Synthesize an internal-error RunRecord. Used in both the `_runOne` catch
 * and the outer safety-net catch so the wire shape stays uniform.
 *
 * @param {{ meta: JobMeta, err: unknown }} input
 * @returns {RunRecord}
 */
function synthesizeInternalRun({ meta, err }) {
  return {
    model: meta.model,
    tier: meta.tier,
    status: 'failed',
    session_id: null,
    text: '',
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    transcript_path: null,
    warnings: [],
    exit_reason: 'internal',
    error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Last-resort failure writer for the outer safety-net. Runs post-flight
 * best-effort and writes a synthesized internal-error result + terminal
 * status. Swallows its own errors — there's nothing further to fall back to.
 *
 * @param {{ state_dir: string, meta: JobMeta, err: unknown, repoRoot: string, postFlightFn: typeof runWorktreePostFlight }} input
 * @returns {Promise<void>}
 */
async function writeWorkerInternalFailure({ state_dir, meta, err, repoRoot, postFlightFn }) {
  /** @type {{ cleanup_status: WorktreeCleanupStatus, followup_commands: string[], warnings: string[] }} */
  let postFlight = {
    cleanup_status: 'kept-due-to-failure',
    followup_commands: [],
    warnings: [`worker internal failure: ${err instanceof Error ? err.message : String(err)}`],
  };
  try {
    postFlight = await postFlightFn({
      worktreeInfo: meta.worktree,
      runStatus: 'failed',
      keep: meta.keep,
      repoRoot,
    });
    postFlight.warnings.push(`worker internal failure: ${err instanceof Error ? err.message : String(err)}`);
  } catch {
    /* fall through with the synthesized fallback above */
  }
  try {
    const run = synthesizeInternalRun({ meta, err });
    const result = buildResult({ run, command: meta.command, meta, postFlight, repoRoot });
    await writeResult(state_dir, result);
  } catch {
    /* result.json may already exist (synthesizeStale beat us) or disk is unwritable */
  }
  try {
    await writeStatus(state_dir, {
      status: 'failed',
      started_at: meta.started_at,
      finished_at: new Date().toISOString(),
    });
  } catch {
    /* nothing else we can do — job stays 'completing' or 'running' on disk */
  }
}

/**
 * Worker entry. Reads meta, runs cursor-agent inside the worktree with
 * tee + cancel-poll, writes result.json + terminal status.json.
 *
 * `_runOne` / `_runPostFlight` are test-only injection seams: the first lets a
 * test fake the cursor-agent run; the second lets a test exercise the
 * P4 outer safety-net by forcing post-flight to throw. Production callers omit
 * both.
 *
 * @param {{ state_dir: string, repoRoot: string, _runOne?: typeof defaultRunOne, _runPostFlight?: typeof runWorktreePostFlight }} input
 * @returns {Promise<void>}
 */
export async function runWorker({
  state_dir,
  repoRoot,
  _runOne = defaultRunOne,
  _runPostFlight = runWorktreePostFlight,
}) {
  // F1 (Grok G1): meta.json read inside the outer safety net. If meta is
  // unreadable we can't synthesize a useful result.json (no model/tier/
  // worktree to reference), but we CAN flip status.json to 'failed' so the
  // job doesn't strand. Best-effort — both writes are guarded.
  /** @type {JobMeta} */
  let meta;
  try {
    meta = JSON.parse(await readFile(join(state_dir, 'meta.json'), 'utf8'));
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    const finished_at = new Date().toISOString();
    try {
      await writeStatus(state_dir, { status: 'failed', started_at: finished_at, finished_at });
    } catch {
      /* nothing else we can do — exit with non-zero so the parent stderr fd captures something */
    }
    throw new Error(`worker: unreadable meta.json at ${state_dir}: ${msg}`);
  }
  const workspaceDir = dirname(dirname(state_dir));

  /** @type {import('node:child_process').ChildProcess | null} */
  let procRef = null;
  let killedByCancel = false;
  /** @type {NodeJS.Timeout | undefined} */
  let cancelPoll = setInterval(async () => {
    if (await cancelMarkerExists(state_dir)) {
      if (procRef && !killedByCancel) {
        killedByCancel = true;
        try {
          procRef.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          try {
            procRef?.kill('SIGKILL');
          } catch {
            /* already dead or reaped */
          }
        }, 5000).unref();
      }
    }
  }, 1000);

  try {
    /** @type {RunRecord} */
    let run;
    try {
      run = await _runOne({
        command: meta.command,
        model: meta.model,
        tier: meta.tier,
        vars: meta.vars,
        timeouts: {
          silence_timeout_seconds: meta.silence_timeout_seconds,
          total_timeout_seconds: meta.total_timeout_seconds,
        },
        workspaceDir,
        cwd: meta.worktree.path,
        tee: { stdoutPath: join(state_dir, 'cursor.stdout'), stderrPath: join(state_dir, 'cursor.stderr') },
        onChildSpawned: (proc) => {
          procRef = proc;
        },
      });
    } catch (runErr) {
      // F2 (Grok G2 / Gemini M1): preserve the ORIGINAL _runOne error. If
      // any step below (writeStatus, _runPostFlight, writeResult, terminal
      // writeStatus) throws, the outer catch must report `runErr` as the
      // cause — not the secondary failure. We re-throw runErr from here so
      // the outer catch sees the right `err`.
      if (cancelPoll) clearInterval(cancelPoll);
      cancelPoll = undefined;
      try {
        // Flip to 'completing' (with completing_at) so a parallel reader at
        // TTL boundary doesn't synthesize a stale-failure on top of the real
        // internal-error result.
        await writeStatus(state_dir, {
          status: 'completing',
          started_at: meta.started_at,
          completing_at: new Date().toISOString(),
        });
        const synth = synthesizeInternalRun({ meta, err: runErr });
        const postFlight = await _runPostFlight({
          worktreeInfo: meta.worktree,
          runStatus: 'failed',
          keep: meta.keep,
          repoRoot,
        });
        const result = buildResult({ run: synth, command: meta.command, meta, postFlight, repoRoot });
        await writeResult(state_dir, result);
        await writeStatus(state_dir, {
          status: 'failed',
          started_at: meta.started_at,
          finished_at: new Date().toISOString(),
        });
        return;
      } catch {
        // Secondary failure during the run-failure-write sequence. Rethrow
        // the ORIGINAL runErr so the outer catch surfaces the cause the
        // user actually cares about. The outer safety-net retries
        // writeWorkerInternalFailure with the real (non-injected) post-flight.
        throw runErr;
      }
    }

    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = undefined;

    // P3: keep status.json out of 'running' before post-flight. Stale-detection
    // (synthesizeStale) only triggers on live status; this prevents a
    // TTL-boundary reader from clobbering the real result while
    // runWorktreePostFlight is still in flight on a slow disk / large repo.
    // F8: completing_at anchors the bounded post-flight grace (COMPLETING_TTL_MS).
    await writeStatus(state_dir, {
      status: 'completing',
      started_at: meta.started_at,
      completing_at: new Date().toISOString(),
    });

    /** @type {"completed" | "failed"} */
    const runStatus = run.status === 'completed' ? 'completed' : 'failed';
    const postFlight = await _runPostFlight({
      worktreeInfo: meta.worktree,
      runStatus,
      keep: meta.keep,
      repoRoot,
    });
    const result = buildResult({ run, command: meta.command, meta, postFlight, repoRoot });
    await writeResult(state_dir, result);
    await writeStatus(state_dir, {
      status: killedByCancel || run.exit_reason === 'cancelled' ? 'cancelled' : runStatus,
      started_at: meta.started_at,
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    // Outer safety net (P4): any throw past the inner _runOne catch lands
    // here — e.g. runWorktreePostFlight failing on a missing worktree, or
    // writeStatus failing on a full disk. Without this fallback the job
    // stays `running` / `completing` until stale TTL synthesizes a
    // misleading 'stale' error. Worker stdio is /dev/null by default; see
    // the optional <state_dir>/worker.stderr fd in cursed-mcp.mjs.
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = undefined;
    // Fall back to the real post-flight (not _runPostFlight) — if the
    // injected post-flight is what threw, asking it again will throw too.
    // The real post-flight already swallows its own failures.
    await writeWorkerInternalFailure({ state_dir, meta, err, repoRoot, postFlightFn: runWorktreePostFlight });
  }
}

/**
 * Symlink-safe entry-point check: Claude Code installs plugins via a symlink,
 * which causes `import.meta.url` to resolve through the symlink while
 * `process.argv[1]` stays as the unresolved path. realpath both sides before
 * comparing. Mirrors the helper in `scripts/mcp/cursed-mcp.mjs`.
 *
 * @returns {boolean}
 */
function isEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const state_dir = process.argv[2];
  if (!state_dir) {
    process.stderr.write('error: state_dir argument required\n');
    process.exit(2);
  }
  runWorker({ state_dir, repoRoot: process.cwd() })
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`worker fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}

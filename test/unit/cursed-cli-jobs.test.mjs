import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createJobState, jobStateDir, writeStatus, writeResult, cancelMarkerExists } from '../../scripts/lib/jobs.mjs';

const pexec = promisify(execFile);
const SCRIPT = resolve(fileURLToPath(import.meta.url), '../../..', 'scripts/cursed.mjs');

/**
 * Run cursed.mjs as a subprocess and return { stdout, stderr, exit }.
 *
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @returns {Promise<{ stdout: string, stderr: string, exit: number }>}
 */
async function runCLI(argv, env) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [SCRIPT, ...argv], {
      env: { ...process.env, ...env },
      timeout: 10000,
    });
    return { stdout, stderr, exit: 0 };
  } catch (/** @type {any} */ e) {
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exit: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/**
 * @param {string} id
 * @param {Partial<import('../../scripts/lib/types.d.ts').JobMeta>} [overrides]
 * @returns {import('../../scripts/lib/types.d.ts').JobMeta}
 */
function makeMeta(id, overrides = {}) {
  return {
    version: 1,
    id,
    command: 'delegate',
    tier: 'balanced',
    model: 'auto-sonnet-4-6',
    vars: { TASK: 'noop', REPO_GUIDANCE: '' },
    worktree: { path: `/tmp/wt/${id}`, branch: id, base: 'abc1234' },
    keep: false,
    started_at: new Date(Date.now() - 1000).toISOString(),
    silence_timeout_seconds: 120,
    total_timeout_seconds: 1800,
    retention_days: 7,
    ...overrides,
  };
}

describe('cursed.mjs jobs', () => {
  /** @type {string} */
  let ws;
  /** @type {string} */
  let dataDir;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cursed-cli-jobs-'));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    const { workspaceDir } = await import('../../scripts/lib/state.mjs');
    ws = workspaceDir();
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('jobs status (no args) returns empty sections when no jobs or active runs', async () => {
    const r = await runCLI(['jobs', 'status', '--json'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ jobs: [], active_runs: [] });
  });

  it('jobs status (no args, no --json) emits a clear idle message when nothing is running', async () => {
    const r = await runCLI(['jobs', 'status'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/no jobs or active runs in this workspace/);
  });

  it('jobs status surfaces a live active MCP run alongside an empty jobs table', async () => {
    const { registerActiveRun } = await import('../../scripts/lib/active-runs.mjs');
    await registerActiveRun(ws, {
      id: 'abc1234567890def',
      command: 'review',
      model: 'grok-4',
      tier: 'reasoning',
      pid: process.pid,
      started_at: new Date().toISOString(),
    });

    const rJson = await runCLI(['jobs', 'status', '--json'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(rJson.exit).toBe(0);
    const parsed = JSON.parse(rJson.stdout);
    expect(parsed.jobs).toEqual([]);
    expect(parsed.active_runs).toHaveLength(1);
    expect(parsed.active_runs[0]).toMatchObject({
      id: 'abc1234567890def',
      command: 'review',
      model: 'grok-4',
      tier: 'reasoning',
      pid: process.pid,
    });

    const rText = await runCLI(['jobs', 'status'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(rText.exit).toBe(0);
    expect(rText.stdout).toMatch(/active MCP runs \(1\)/);
    expect(rText.stdout).toMatch(/review/);
    expect(rText.stdout).toMatch(/grok-4/);
  });

  it('jobs status <id> on unknown id exits with UNKNOWN_JOB (6)', async () => {
    const r = await runCLI(['jobs', 'status', 'nope'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(6);
    expect(r.stderr).toMatch(/unknown job/);
  });

  it('jobs result <id> on running job exits with JOB_STILL_RUNNING (5)', async () => {
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    const r = await runCLI(['jobs', 'result', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(5);
    expect(r.stderr).toMatch(/still running/);
  });

  // F12: /cursed:result is result-presence-gated, not status-gated. If
  // result.json exists on disk, print it regardless of status.json. This
  // matters when synthesizeStale's writeStatus fails (F5) — the synthesized
  // result is on disk but status.json is stuck at 'running'/'completing'.
  // Pre-F12 the user could never retrieve that result.
  it('jobs result <id> prints result.json even when status.json says running — F12', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    // status.json stays 'running' (default from createJobState).
    await writeResult(
      sd,
      /** @type {any} */ ({
        panel: false,
        command: 'delegate',
        run: { model: 'm', status: 'failed', exit_reason: 'stale' },
      }),
    );
    const r = await runCLI(['jobs', 'result', 'feat-x', '--json'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.run.exit_reason).toBe('stale');
  });

  it('jobs result <id> on terminal returns the result.json content', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: 't1' });
    await writeResult(
      sd,
      /** @type {any} */ ({ panel: false, command: 'delegate', run: { model: 'm', status: 'completed' } }),
    );
    const r = await runCLI(['jobs', 'result', 'feat-x', '--json'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).run.status).toBe('completed');
  });

  it('jobs result <id> on terminal with missing result.json exits with ALL_RUNS_FAILED (1)', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: 't1' });
    const r = await runCLI(['jobs', 'result', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/terminal but result\.json is missing/);
  });

  it('jobs cancel <id> on terminal is idempotent and returns the existing result', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: 't1' });
    await writeResult(
      sd,
      /** @type {any} */ ({ panel: false, command: 'delegate', run: { model: 'm', status: 'completed' } }),
    );
    const r = await runCLI(['jobs', 'cancel', 'feat-x', '--json'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout).run.status).toBe('completed');
  });

  it('jobs cancel <id> writes the marker and times out with cancel_requested hint', async () => {
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    const r = await runCLI(['jobs', 'cancel', 'feat-x', '--json', '--timeout-seconds', '1'], {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.cancel_requested).toBe(true);
    expect(out.status).toBe('running');
  }, 5000);

  it('jobs forget <id> on terminal deletes the dir', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: 't1' });
    const r = await runCLI(['jobs', 'forget', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(0);
    await expect(stat(sd)).rejects.toThrow();
  });

  it('jobs forget <id> on running refuses', async () => {
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    const r = await runCLI(['jobs', 'forget', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(5);
    expect(r.stderr).toMatch(/still running/);
  });

  // Coverage for `isJobLive` in the CLI surface: `completing` must be
  // treated like `running` by result/cancel/forget — it's the short window
  // between _runOne returning and the worker writing terminal status, so
  // result.json may not exist yet and the worker is still in motion.
  it("jobs result <id> on a 'completing' job exits with JOB_STILL_RUNNING (5)", async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completing', started_at: 't0' });
    const r = await runCLI(['jobs', 'result', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(5);
    expect(r.stderr).toMatch(/still running/);
  });

  it("jobs cancel <id> on a 'completing' job writes the marker and waits", async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completing', started_at: 't0' });
    const r = await runCLI(['jobs', 'cancel', 'feat-x', '--json', '--timeout-seconds', '1'], {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    // The cancel-marker was written and the wait loop hit its timeout
    // without seeing a terminal status — the proof that `completing` was
    // treated as live (an `isJobLive` regression would short-circuit on
    // the initial read and never write the marker). The reported status
    // must match disk reality (`completing`), not the previously
    // hardcoded `'running'` sentinel.
    expect(out.cancel_requested).toBe(true);
    expect(out.status).toBe('completing');
    expect(await cancelMarkerExists(sd)).toBe(true);
  }, 5000);

  // P1 regression guard. The cancel wait loop has two terminal-detection
  // branches: in-loop (runs after each 1s sleep) and post-loop (runs once
  // after the deadline elapses). Both must emit the real result.json when
  // the job transitions to terminal during cancel — pre-P1-fix, the
  // post-loop branch unconditionally emitted a `{status, cancel_requested,
  // hint}` shape claiming result.json wasn't written, even when it had
  // just landed. Mutating disk ~500ms into a 3s-timeout cancel exercises
  // the in-loop branch deterministically (the post-loop branch fires only
  // in a sub-millisecond window that isn't reachable without a hook).
  // After P1, both branches share the same "if not live, emit
  // result/finished-fallback" shape — so this test pins the user-visible
  // contract across the disk-transition scenario.
  it('jobs cancel <id> emits real result.json when worker becomes terminal mid-cancel', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completing', started_at: 't0', completing_at: new Date().toISOString() });
    const cliPromise = runCLI(['jobs', 'cancel', 'feat-x', '--json', '--timeout-seconds', '3'], {
      CLAUDE_PLUGIN_DATA: dataDir,
    });
    setTimeout(async () => {
      await writeResult(
        sd,
        /** @type {any} */ ({
          panel: false,
          command: 'delegate',
          run: {
            model: 'm',
            status: 'completed',
            text: 'sentinel-P1-race',
            tokens: { input: 0, output: 0 },
          },
        }),
      );
      await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: new Date().toISOString() });
    }, 500);
    const r = await cliPromise;
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.run.status).toBe('completed');
    expect(out.run.text).toBe('sentinel-P1-race');
    expect(out.cancel_requested).toBeUndefined();
    expect(out.hint).toBeUndefined();
  }, 10000);

  // gemini-3.1-pro panel-review-3 follow-up: a concurrent /cursed:forget
  // (or external rm) can delete the state dir while /cursed:cancel is in
  // its wait loop. Pre-fix, readJob's meta-read threw ENOENT and crashed
  // the CLI with an unhandled promise rejection — client scripts expecting
  // structured JSON got a stack trace. The try/catch wrapper now emits a
  // structured `{ cancel_requested, gone, hint }` payload instead.
  it('jobs cancel <id> survives concurrent state-dir rm during wait', async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completing', started_at: 't0', completing_at: new Date().toISOString() });

    const child = spawn(process.execPath, [SCRIPT, 'jobs', 'cancel', 'feat-x', '--json', '--timeout-seconds', '5'], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    // Wait until the cancel marker shows up → CLI has entered the wait loop.
    // Poll on a short cadence so the test isn't tied to the loop's 1s sleep.
    let markerSeen = false;
    for (let i = 0; i < 50; i++) {
      if (await cancelMarkerExists(sd)) {
        markerSeen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(markerSeen).toBe(true);

    // Simulate a concurrent /cursed:forget (or external cleanup).
    await rm(sd, { recursive: true, force: true });

    const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
    expect(exitCode).toBe(0);
    // No unhandled-rejection stack trace leaked to stderr:
    expect(stderr).not.toMatch(/UnhandledPromiseRejection|ENOENT|unreadable meta\.json/);
    const out = JSON.parse(stdout);
    expect(out.cancel_requested).toBe(true);
    expect(out.gone).toBe(true);
    expect(typeof out.hint).toBe('string');
  }, 10000);

  it("jobs forget <id> on a 'completing' job refuses", async () => {
    const sd = jobStateDir(ws, 'feat-x');
    await createJobState({ workspaceDir: ws, id: 'feat-x', meta: makeMeta('feat-x') });
    await writeStatus(sd, { status: 'completing', started_at: 't0' });
    const r = await runCLI(['jobs', 'forget', 'feat-x'], { CLAUDE_PLUGIN_DATA: dataDir });
    expect(r.exit).toBe(5);
    expect(r.stderr).toMatch(/still running/);
  });
});

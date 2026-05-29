import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJobState, jobStateDir, writeCancelMarker, readJob } from '../../scripts/lib/jobs.mjs';
import { runWorker } from '../../scripts/cursed-job.mjs';

const pexec = promisify(execFile);

/** @param {string} id */
async function realRepoWithWorktree(id) {
  const repo = await mkdtemp(join(tmpdir(), 'cursed-worker-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: repo });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: repo });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  const wtPath = join(repo, '.cursed', 'worktrees', id);
  await mkdir(join(repo, '.cursed', 'worktrees'), { recursive: true });
  await pexec('git', ['worktree', 'add', wtPath, '-b', id, 'HEAD'], { cwd: repo });
  const headSha = (await pexec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  return { repo, wtPath, headSha };
}

/**
 * @param {string} id
 * @param {string} wtPath
 * @param {string} base
 * @param {Partial<import('../../scripts/lib/types.d.ts').JobMeta>} [overrides]
 * @returns {import('../../scripts/lib/types.d.ts').JobMeta}
 */
function makeMeta(id, wtPath, base, overrides = {}) {
  return /** @type {import('../../scripts/lib/types.d.ts').JobMeta} */ ({
    version: /** @type {1} */ (1),
    id,
    command: 'delegate',
    tier: 'balanced',
    model: 'auto-sonnet-4-6',
    vars: { TASK: 'noop', REPO_GUIDANCE: '' },
    worktree: { path: wtPath, branch: id, base },
    keep: false,
    started_at: new Date().toISOString(),
    silence_timeout_seconds: 10,
    total_timeout_seconds: 30,
    retention_days: 7,
    ...overrides,
  });
}

describe('runWorker (background job worker)', () => {
  it('writes result.json + terminal status.json on runOne completion', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-a');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-a', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-a', meta });
      const sd = jobStateDir(ws, 'feat-a');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => ({
          model: meta.model,
          tier: /** @type {import('../../scripts/lib/types.d.ts').Tier} */ ('balanced'),
          status: /** @type {'completed'} */ ('completed'),
          session_id: 'sess-1',
          text: 'done',
          files_changed: [],
          commands_run: [],
          tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          duration_ms: 10,
          transcript_path: null,
          exit_reason: 'completed',
          warnings: [],
        }))
      );

      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne });

      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('completed');
      expect(status.finished_at).toBeDefined();
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.panel).toBe(false);
      expect(result.run.status).toBe('completed');
      expect(result.worktree.cleanup_status).toBe('removed');
      const firstCall = /** @type {any[]} */ (fakeRunOne.mock.calls)[0];
      expect(firstCall[0].cwd).toBe(wtPath);
      expect(firstCall[0].tee.stdoutPath).toBe(join(sd, 'cursor.stdout'));
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('writes failed result + kept-due-to-failure on runOne run-level failure', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-b');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-b', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-b', meta });
      const sd = jobStateDir(ws, 'feat-b');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => ({
          model: meta.model,
          tier: /** @type {import('../../scripts/lib/types.d.ts').Tier} */ ('balanced'),
          status: /** @type {'failed'} */ ('failed'),
          session_id: null,
          text: '',
          files_changed: [],
          commands_run: [],
          tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          duration_ms: 5,
          transcript_path: null,
          exit_reason: 'stall',
          warnings: [],
          error: { code: 'stall', message: 'silence timeout' },
        }))
      );

      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne });

      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('failed');
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.run.error.code).toBe('stall');
      expect(result.worktree.cleanup_status).toBe('kept-due-to-failure');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('synthesizes internal error when runOne throws', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-c');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-c', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-c', meta });
      const sd = jobStateDir(ws, 'feat-c');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => {
          throw new Error('boom');
        })
      );
      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne });

      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('failed');
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.run.error.code).toBe('internal');
      expect(result.run.error.message).toMatch(/boom/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("flips status.json to 'completing' before post-flight so a TTL-boundary reader does not synthesize stale failure", async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-race');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      // TTL = total_timeout_seconds * 1000 + 60_000 grace = 60_000 ms.
      // Backdate started_at by 59_900ms so the TTL elapses ~100ms after
      // worker entry — i.e. mid-post-flight in this test's timeline.
      const meta = makeMeta('feat-race', wtPath, headSha, {
        total_timeout_seconds: 0,
        silence_timeout_seconds: 0,
        started_at: new Date(Date.now() - 59_900).toISOString(),
      });
      await createJobState({ workspaceDir: ws, id: 'feat-race', meta });
      const sd = jobStateDir(ws, 'feat-race');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => ({
          model: meta.model,
          tier: /** @type {import('../../scripts/lib/types.d.ts').Tier} */ ('balanced'),
          status: /** @type {'completed'} */ ('completed'),
          session_id: 'sess-race',
          text: 'real output',
          files_changed: [],
          commands_run: [],
          tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          duration_ms: 10,
          transcript_path: null,
          exit_reason: 'completed',
          warnings: [],
        }))
      );

      // Stretch post-flight to ~300ms so the probe loop reliably runs
      // readJob while status=completing AND meta is past TTL. Forward to
      // the real post-flight so the worktree is cleaned up correctly.
      const { runWorktreePostFlight } = await import('../../scripts/lib/worktree.mjs');
      const fakePostFlight = /** @type {any} */ (
        vi.fn(async (/** @type {any} */ pfArgs) => {
          await new Promise((r) => setTimeout(r, 300));
          return runWorktreePostFlight(pfArgs);
        })
      );

      const workerPromise = runWorker({
        state_dir: sd,
        repoRoot: repo,
        _runOne: fakeRunOne,
        _runPostFlight: fakePostFlight,
      });

      let sawCompleting = false;
      let sawSynthesizedStale = false;
      const probeDeadline = Date.now() + 1500;
      while (Date.now() < probeDeadline) {
        const r = await readJob(sd);
        if (r.status.status === 'completing') sawCompleting = true;
        if (r.result?.run.error?.code === 'stale') sawSynthesizedStale = true;
        if (r.status.status === 'completed' || r.status.status === 'failed') break;
        await new Promise((res) => setTimeout(res, 20));
      }
      await workerPromise;

      // Contract: no synthesized stale failure on disk regardless of probe timing.
      expect(sawSynthesizedStale).toBe(false);
      const finalResult = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(finalResult.run.text).toBe('real output');
      expect(finalResult.run.error).toBeUndefined();
      const finalStatus = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(finalStatus.status).toBe('completed');
      // Probe should observe completing at least once given the 300ms
      // post-flight delay against 20ms probe cadence.
      expect(sawCompleting).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  }, 8000);

  it('preserves the original _runOne error when post-flight throws inside the inner catch (F2 / Gemini M1)', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-cause');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-cause', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-cause', meta });
      const sd = jobStateDir(ws, 'feat-cause');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => {
          throw new Error('ORIGINAL_RUNONE_ERR');
        })
      );
      const fakePostFlight = /** @type {any} */ (
        vi.fn(async () => {
          throw new Error('SECONDARY_POSTFLIGHT_ERR');
        })
      );
      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne, _runPostFlight: fakePostFlight });

      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('failed');
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      // The synthesized result MUST surface the original _runOne error, not
      // the post-flight error that shadowed it under the previous code.
      expect(result.run.error.message).toMatch(/ORIGINAL_RUNONE_ERR/);
      expect(result.run.error.message).not.toMatch(/SECONDARY_POSTFLIGHT_ERR/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('throws on unreadable meta.json but still writes a terminal status.json (F1 / Grok G1)', async () => {
    const { repo } = await realRepoWithWorktree('feat-meta');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      // Make a state_dir without writing meta.json — runWorker will fail to read.
      const sd = jobStateDir(ws, 'feat-no-meta');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(sd, { recursive: true });
      await expect(runWorker({ state_dir: sd, repoRoot: repo })).rejects.toThrow(/unreadable meta.json/);
      // status.json is the load-bearing recovery signal: even without meta we
      // must flip it to terminal so /cursed:status doesn't see 'running'.
      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('failed');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('outer safety-net writes terminal status + internal-error result when post-flight throws', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-net');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-net', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-net', meta });
      const sd = jobStateDir(ws, 'feat-net');

      const fakeRunOne = /** @type {any} */ (
        vi.fn(async () => ({
          model: meta.model,
          tier: /** @type {import('../../scripts/lib/types.d.ts').Tier} */ ('balanced'),
          status: /** @type {'completed'} */ ('completed'),
          session_id: 'sess-net',
          text: 'output',
          files_changed: [],
          commands_run: [],
          tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
          duration_ms: 10,
          transcript_path: null,
          exit_reason: 'completed',
          warnings: [],
        }))
      );
      // First call (success path) throws; second call (from
      // writeWorkerInternalFailure fallback) is wired to the REAL post-flight
      // imported by the worker module, so the test doesn't intercept it.
      const fakePostFlight = /** @type {any} */ (
        vi.fn(async () => {
          throw new Error('synthetic post-flight failure');
        })
      );

      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne, _runPostFlight: fakePostFlight });

      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('failed');
      expect(status.finished_at).toBeDefined();
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.run.error.code).toBe('internal');
      expect(result.run.exit_reason).toBe('internal');
      expect(result.run.error.message).toMatch(/synthetic post-flight failure/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('fires SIGTERM on cancel.marker detection during the run', async () => {
    const { repo, wtPath, headSha } = await realRepoWithWorktree('feat-d');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-worker-ws-'));
    try {
      const meta = makeMeta('feat-d', wtPath, headSha);
      await createJobState({ workspaceDir: ws, id: 'feat-d', meta });
      const sd = jobStateDir(ws, 'feat-d');

      // pid intentionally omitted so killProcessTree skips the group-signal
      // branch (process.kill(-pid)) and only the direct `kill` spy fires.
      // Setting a real-looking pid would risk delivering a signal to an
      // unrelated process group that happens to share that pgid.
      /** @type {any} */
      const fakeProc = { kill: vi.fn(() => true) };
      const fakeRunOne = /** @type {any} */ (
        vi.fn(async (/** @type {any} */ { onChildSpawned }) => {
          onChildSpawned?.(fakeProc);
          await writeCancelMarker(sd);
          await new Promise((r) => setTimeout(r, 1500));
          return {
            model: meta.model,
            tier: /** @type {import('../../scripts/lib/types.d.ts').Tier} */ ('balanced'),
            status: /** @type {'failed'} */ ('failed'),
            session_id: null,
            text: '',
            files_changed: [],
            commands_run: [],
            tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            duration_ms: 1500,
            transcript_path: null,
            exit_reason: 'cancelled',
            warnings: [],
            error: { code: 'cancelled', message: 'SIGTERM' },
          };
        })
      );

      await runWorker({ state_dir: sd, repoRoot: repo, _runOne: fakeRunOne });
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.run.exit_reason).toBe('cancelled');
      const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(status.status).toBe('cancelled');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  }, 8000);
});

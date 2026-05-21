import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jobsDir,
  jobStateDir,
  createJobState,
  readJob,
  listJobs,
  writeStatus,
  writeResult,
  writeCancelMarker,
  cancelMarkerExists,
  gcWorkspaceJobs,
  synthesizeStale,
} from '../../scripts/lib/jobs.mjs';

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

describe('jobsDir / jobStateDir', () => {
  it('builds workspace and per-job paths', () => {
    expect(jobsDir('/w')).toBe(join('/w', 'jobs'));
    expect(jobStateDir('/w', 'feat-x')).toBe(join('/w', 'jobs', 'feat-x'));
  });
});

describe('createJobState', () => {
  it('creates dir, writes meta.json + initial status.json, returns paths', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-x');
      const r = await createJobState({ workspaceDir: ws, id: 'feat-x', meta });
      expect(r.state_dir).toBe(jobStateDir(ws, 'feat-x'));
      expect(r.stdoutPath).toBe(join(r.state_dir, 'cursor.stdout'));
      expect(r.stderrPath).toBe(join(r.state_dir, 'cursor.stderr'));
      const m = JSON.parse(await readFile(join(r.state_dir, 'meta.json'), 'utf8'));
      expect(m.id).toBe('feat-x');
      const s = JSON.parse(await readFile(join(r.state_dir, 'status.json'), 'utf8'));
      expect(s.status).toBe('running');
      expect(s.started_at).toBe(meta.started_at);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('createJobState (id reuse)', () => {
  it('clears stale per-run artifacts when the same id is reused (prior status terminal)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-x');
      const r = await createJobState({ workspaceDir: ws, id: 'feat-x', meta });
      // Simulate detritus from a prior terminal run that shared the id:
      /** @type {any} */
      const oldResult = { panel: false, command: 'delegate', run: { model: 'old' } };
      await writeResult(r.state_dir, oldResult);
      await writeCancelMarker(r.state_dir);
      await writeFile(join(r.state_dir, 'cursor.stdout'), 'old stdout', 'utf8');
      await writeFile(join(r.state_dir, 'cursor.stderr'), 'old stderr', 'utf8');
      await writeFile(join(r.state_dir, 'worker.stderr'), 'old worker stderr', 'utf8');
      // F11: result.json is no longer terminal evidence. Flip status to a
      // real terminal state so the reuse gate accepts.
      await writeStatus(r.state_dir, { status: 'completed', started_at: meta.started_at, finished_at: 't1' });
      const meta2 = makeMeta('feat-x', { model: 'new' });
      await createJobState({ workspaceDir: ws, id: 'feat-x', meta: meta2 });
      await expect(stat(join(r.state_dir, 'result.json'))).rejects.toThrow();
      expect(await cancelMarkerExists(r.state_dir)).toBe(false);
      await expect(stat(join(r.state_dir, 'cursor.stdout'))).rejects.toThrow();
      await expect(stat(join(r.state_dir, 'cursor.stderr'))).rejects.toThrow();
      await expect(stat(join(r.state_dir, 'worker.stderr'))).rejects.toThrow();
      // meta + status are rewritten:
      const m = JSON.parse(await readFile(join(r.state_dir, 'meta.json'), 'utf8'));
      expect(m.model).toBe('new');
      const s = JSON.parse(await readFile(join(r.state_dir, 'status.json'), 'utf8'));
      expect(s.status).toBe('running');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a live prior job (status=running, within TTL, no result.json) — F4', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-live');
      await createJobState({ workspaceDir: ws, id: 'feat-live', meta });
      // No result.json, status=running, started_at recent → F4 refuses.
      const meta2 = makeMeta('feat-live', { model: 'new' });
      await expect(createJobState({ workspaceDir: ws, id: 'feat-live', meta: meta2 })).rejects.toThrow(/job_id_in_use/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('allows reuse when prior job is past TTL (presumed-dead worker) — F4', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-stale', {
        started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        total_timeout_seconds: 60,
      });
      await createJobState({ workspaceDir: ws, id: 'feat-stale', meta });
      // status=running on disk but started_at is 24h ago → F4 allows.
      const meta2 = makeMeta('feat-stale', { model: 'new' });
      const r = await createJobState({ workspaceDir: ws, id: 'feat-stale', meta: meta2 });
      const m = JSON.parse(await readFile(join(r.state_dir, 'meta.json'), 'utf8'));
      expect(m.model).toBe('new');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('allows reuse when prior job is terminal — F4', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-done');
      const r = await createJobState({ workspaceDir: ws, id: 'feat-done', meta });
      await writeStatus(r.state_dir, { status: 'completed', started_at: meta.started_at, finished_at: 'now' });
      const meta2 = makeMeta('feat-done', { model: 'new' });
      const r2 = await createJobState({ workspaceDir: ws, id: 'feat-done', meta: meta2 });
      const m = JSON.parse(await readFile(join(r2.state_dir, 'meta.json'), 'utf8'));
      expect(m.model).toBe('new');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // F10: createJobState's `completing` TTL must anchor on `completing_at`
  // (matching readJob), not on `started_at`. Any job whose run exceeded
  // COMPLETING_TTL_MS before flipping to `completing` would otherwise be
  // treated as expired the moment it flipped — allowing a new job to
  // clobber the live worker still doing post-flight.
  it("refuses reuse when prior 'completing' is fresh, even though started_at is ancient — F10", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      // started_at 5h ago, total_timeout 60s → running-TTL is long expired.
      // But completing_at is 30s ago, well inside COMPLETING_TTL_MS (120s).
      const startedAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      const meta = makeMeta('feat-completing', { started_at: startedAt, total_timeout_seconds: 60 });
      await createJobState({ workspaceDir: ws, id: 'feat-completing', meta });
      await writeStatus(jobStateDir(ws, 'feat-completing'), {
        status: 'completing',
        started_at: startedAt,
        completing_at: new Date(Date.now() - 30_000).toISOString(),
      });
      const meta2 = makeMeta('feat-completing', { model: 'new' });
      await expect(createJobState({ workspaceDir: ws, id: 'feat-completing', meta: meta2 })).rejects.toThrow(
        /job_id_in_use/,
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("allows reuse when prior 'completing' is past COMPLETING_TTL_MS — F10", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const startedAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
      const meta = makeMeta('feat-stale-completing', { started_at: startedAt, total_timeout_seconds: 60 });
      await createJobState({ workspaceDir: ws, id: 'feat-stale-completing', meta });
      await writeStatus(jobStateDir(ws, 'feat-stale-completing'), {
        status: 'completing',
        started_at: startedAt,
        completing_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min > 2min TTL
      });
      const meta2 = makeMeta('feat-stale-completing', { model: 'new' });
      const r = await createJobState({ workspaceDir: ws, id: 'feat-stale-completing', meta: meta2 });
      const m = JSON.parse(await readFile(join(r.state_dir, 'meta.json'), 'utf8'));
      expect(m.model).toBe('new');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // F10 regression guard: readJob and createJobState must agree on the same
  // input. A fresh 'completing' job (within COMPLETING_TTL_MS) → readJob
  // returns it as live, AND createJobState refuses to clobber it.
  it("readJob and createJobState agree on 'completing' liveness — F10", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const startedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      const meta = makeMeta('feat-agree', { started_at: startedAt, total_timeout_seconds: 60 });
      await createJobState({ workspaceDir: ws, id: 'feat-agree', meta });
      const sd = jobStateDir(ws, 'feat-agree');
      await writeStatus(sd, {
        status: 'completing',
        started_at: startedAt,
        completing_at: new Date(Date.now() - 10_000).toISOString(),
      });
      const r = await readJob(sd);
      expect(r.status.status).toBe('completing'); // readJob: live
      await expect(
        createJobState({ workspaceDir: ws, id: 'feat-agree', meta: makeMeta('feat-agree', { model: 'new' }) }),
      ).rejects.toThrow(/job_id_in_use/); // createJobState: live → refuse
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // P2 mirror: createJobState's F4 path must use completing_at as the live
  // anchor for `completing` jobs whose started_at is unparseable. Pre-P2,
  // such a job was treated as immediately-stale by liveDeadlineMs, letting
  // a same-id call clobber a still-active worker's dir.
  it("refuses reuse when prior 'completing' is fresh, even when started_at is unparseable — P2", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-p2', { started_at: 'not-a-date' });
      await createJobState({ workspaceDir: ws, id: 'feat-p2', meta });
      await writeStatus(jobStateDir(ws, 'feat-p2'), {
        status: 'completing',
        started_at: 'not-a-date',
        completing_at: new Date().toISOString(),
      });
      const meta2 = makeMeta('feat-p2', { model: 'new' });
      await expect(createJobState({ workspaceDir: ws, id: 'feat-p2', meta: meta2 })).rejects.toThrow(/job_id_in_use/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("allows reuse when prior 'completing' is past TTL, even when started_at is unparseable — P2", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('feat-p2-stale', { started_at: 'not-a-date' });
      await createJobState({ workspaceDir: ws, id: 'feat-p2-stale', meta });
      await writeStatus(jobStateDir(ws, 'feat-p2-stale'), {
        status: 'completing',
        started_at: 'not-a-date',
        completing_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min > 2min TTL
      });
      const meta2 = makeMeta('feat-p2-stale', { started_at: new Date().toISOString(), model: 'new' });
      const r = await createJobState({ workspaceDir: ws, id: 'feat-p2-stale', meta: meta2 });
      const m = JSON.parse(await readFile(join(r.state_dir, 'meta.json'), 'utf8'));
      expect(m.model).toBe('new');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // F11: result.json is NOT terminal evidence — the worker writes result.json
  // before flipping status.json to a terminal state. Without F11, the
  // !priorResultPresent exemption let a new job clobber a still-live worker
  // mid-post-flight. The TTL check alone must gate live-reuse.
  it("refuses reuse when prior 'completing' is fresh, even with result.json present — F11", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const startedAt = new Date(Date.now() - 100).toISOString();
      const meta = makeMeta('feat-f11', { started_at: startedAt });
      const r = await createJobState({ workspaceDir: ws, id: 'feat-f11', meta });
      await writeStatus(r.state_dir, {
        status: 'completing',
        started_at: startedAt,
        completing_at: new Date().toISOString(),
      });
      /** @type {any} */
      const partial = { panel: false, command: 'delegate', run: { model: 'm' } };
      await writeResult(r.state_dir, partial);
      const meta2 = makeMeta('feat-f11', { model: 'new' });
      await expect(createJobState({ workspaceDir: ws, id: 'feat-f11', meta: meta2 })).rejects.toThrow(/job_id_in_use/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe("readJob — 'completing' status (F8 bounded TTL)", () => {
  it("treats fresh 'completing' as live (skips stale-synthesis)", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', {
        started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // past 'running' TTL
        total_timeout_seconds: 60,
      });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      await writeStatus(jobStateDir(ws, 'j'), {
        status: 'completing',
        started_at: meta.started_at,
        completing_at: new Date().toISOString(),
      });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('completing');
      expect(r.result).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("synthesizes stale when 'completing' is past COMPLETING_TTL_MS (OOM/SIGKILL in post-flight)", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', {
        started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        total_timeout_seconds: 60,
      });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      await writeStatus(jobStateDir(ws, 'j'), {
        status: 'completing',
        started_at: meta.started_at,
        completing_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min ago > 2min TTL
      });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('failed');
      expect(r.result?.run.error?.code).toBe('stale');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // P2: a `completing` job whose `meta.started_at` is unparseable (corrupt
  // partial write — the F8 schema window, or any future torn-write
  // scenario) must still be anchored on `completing_at`. Pre-P2,
  // `liveDeadlineMs` short-circuited to 0 the moment `started_at` failed
  // to parse, marking a perfectly live `completing` job as stale and
  // letting `createJobState`'s F4 path clobber its dir mid-completion.
  it("treats fresh 'completing' as live even when started_at is unparseable — P2", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', { started_at: 'not-a-date' });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      await writeStatus(jobStateDir(ws, 'j'), {
        status: 'completing',
        started_at: 'not-a-date',
        completing_at: new Date().toISOString(),
      });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('completing');
      expect(r.result).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("synthesizes stale when 'completing' with unparseable started_at is past COMPLETING_TTL_MS — P2", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', { started_at: 'not-a-date' });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      await writeStatus(jobStateDir(ws, 'j'), {
        status: 'completing',
        started_at: 'not-a-date',
        completing_at: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min > 2min TTL
      });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('failed');
      expect(r.result?.run.error?.code).toBe('stale');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('writeStatus / writeResult / writeCancelMarker', () => {
  it('writes status atomically', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const sd = jobStateDir(ws, 'j');
      await mkdir(sd, { recursive: true });
      await writeStatus(sd, { status: 'completed', started_at: 't0', finished_at: 't1' });
      const s = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(s.status).toBe('completed');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('writeResult refuses to overwrite an existing result.json', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const sd = jobStateDir(ws, 'j');
      await mkdir(sd, { recursive: true });
      /** @type {any} */
      const first = { panel: false, command: 'delegate', run: { model: 'a' } };
      /** @type {any} */
      const second = { panel: false, command: 'delegate', run: { model: 'b' } };
      const a = await writeResult(sd, first);
      const b = await writeResult(sd, second);
      expect(a.wrote).toBe(true);
      expect(b.wrote).toBe(false);
      const r = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(r.run.model).toBe('a');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // F15: pre-fix, atomicWrite's tmp filename used Date.now() — same-ms
  // concurrent calls in one process collided on the tmp path, letting B
  // truncate A's open file before A's rename, then B's rename ENOENT'd.
  // hrtime+counter makes the tmp path unique per call.
  it('atomicWrite tolerates concurrent calls without ENOENT — F15', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const sd = jobStateDir(ws, 'j');
      await mkdir(sd, { recursive: true });
      // 10 concurrent writeStatus calls to the same status.json. The fix is
      // probabilistic — pre-fix collisions only happen when two callers race
      // within the same ms — but 10 concurrent invocations on a fast machine
      // reliably trip the old code with ENOENT, while the new code always
      // wins. We assert no rejection rather than a specific final content.
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => writeStatus(sd, { status: 'running', started_at: `t${i}` })),
      );
      const s = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(s.status).toBe('running'); // one of the 10 writes won
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('writeCancelMarker is idempotent and preserves first-cancel timestamp', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const sd = jobStateDir(ws, 'j');
      await mkdir(sd, { recursive: true });
      expect(await cancelMarkerExists(sd)).toBe(false);
      await writeCancelMarker(sd);
      const firstContent = await readFile(join(sd, 'cancel.marker'), 'utf8');
      expect(await cancelMarkerExists(sd)).toBe(true);
      // Wait at least 2ms to ensure ISO timestamp would differ
      await new Promise((r) => setTimeout(r, 5));
      await writeCancelMarker(sd);
      const secondContent = await readFile(join(sd, 'cancel.marker'), 'utf8');
      expect(secondContent).toBe(firstContent);
      expect(await cancelMarkerExists(sd)).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('readJob', () => {
  it('returns meta+status for a running job within TTL', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j');
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.meta.id).toBe('j');
      expect(r.status.status).toBe('running');
      expect(r.result).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('synthesizes-and-persists stale terminal state for a running job past TTL', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', { started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('failed');
      expect(r.result?.run.error?.code).toBe('stale');
      const r2 = await readJob(jobStateDir(ws, 'j'));
      expect(r2.result?.run.error?.code).toBe('stale');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('treats unparseable meta.started_at as immediate-stale instead of stranding the job', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', { started_at: 'not-a-date' });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      const r = await readJob(jobStateDir(ws, 'j'));
      expect(r.status.status).toBe('failed');
      expect(r.result?.run.error?.code).toBe('stale');
      // duration_ms must be finite even though started_at was malformed.
      expect(Number.isFinite(r.result?.run.duration_ms)).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing result.json when re-synthesizing', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j', { started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      await readJob(jobStateDir(ws, 'j'));
      const sd = jobStateDir(ws, 'j');
      const before = await readFile(join(sd, 'result.json'), 'utf8');
      await readJob(sd);
      const after = await readFile(join(sd, 'result.json'), 'utf8');
      expect(after).toBe(before);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('synthesizeStale', () => {
  it('preserves a real result.json that was written before status.json was updated', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const meta = makeMeta('j');
      await createJobState({ workspaceDir: ws, id: 'j', meta });
      const sd = jobStateDir(ws, 'j');
      // Simulate: worker wrote result.json with real data, then crashed.
      /** @type {any} */
      const realResult = {
        panel: false,
        command: 'delegate',
        run: { model: 'real', status: 'completed', text: 'work output' },
      };
      await writeResult(sd, realResult);
      // Note: status.json was never updated by the (dead) worker. It still says 'running'.
      const { status, result, synthesized } = await synthesizeStale({ state_dir: sd, meta, now: Date.now() });
      expect(synthesized).toBe(false);
      expect(result.run.model).toBe('real');
      expect(result.run.text).toBe('work output');
      expect(status.status).toBe('failed');
      // And status.json is now flipped to 'failed' on disk:
      const onDisk = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
      expect(onDisk.status).toBe('failed');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('listJobs', () => {
  it('lists all job dirs and tolerates a corrupt status.json', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      await createJobState({ workspaceDir: ws, id: 'a', meta: makeMeta('a') });
      await createJobState({ workspaceDir: ws, id: 'b', meta: makeMeta('b') });
      await writeFile(join(jobStateDir(ws, 'b'), 'status.json'), 'not-json', 'utf8');
      await writeFile(join(jobsDir(ws), 'README.txt'), 'note', 'utf8');
      const jobs = await listJobs(ws);
      const ids = jobs.map((j) => j.id).sort();
      expect(ids).toEqual(['a', 'b']);
      const b = jobs.find((j) => j.id === 'b');
      expect(b?.warning).toMatch(/status.json/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('gcWorkspaceJobs', () => {
  it('deletes terminal jobs past retention; keeps running ones', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      await createJobState({ workspaceDir: ws, id: 'old', meta: makeMeta('old', { started_at: longAgo }) });
      await writeStatus(jobStateDir(ws, 'old'), { status: 'completed', started_at: longAgo, finished_at: longAgo });
      await createJobState({ workspaceDir: ws, id: 'fresh', meta: makeMeta('fresh') });
      const r = await gcWorkspaceJobs(ws, { retentionDays: 7, now: Date.now() });
      expect(r.deleted).toEqual(['old']);
      await expect(stat(jobStateDir(ws, 'old'))).rejects.toThrow();
      await expect(stat(jobStateDir(ws, 'fresh'))).resolves.toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('returns counts and never throws on per-job error', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      await mkdir(jobsDir(ws), { recursive: true });
      await mkdir(jobStateDir(ws, 'broken'), { recursive: true });
      const r = await gcWorkspaceJobs(ws, { retentionDays: 7, now: Date.now() });
      expect(r.scanned).toBe(1);
      expect(r.deleted).toEqual([]);
      expect(r.warnings.length).toBeGreaterThan(0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // F14: a state_dir with unreadable/missing meta.json makes readJob throw,
  // which pre-fix caused gc to skip the dir forever. With the fs-mtime
  // fallback, an old corrupted dir gets GC'd by mtime — the warning is still
  // recorded so the corruption isn't hidden.
  it('gcs an unreadable-meta dir via mtime fallback when stale — F14', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      await mkdir(jobsDir(ws), { recursive: true });
      const sd = jobStateDir(ws, 'corrupt');
      await mkdir(sd, { recursive: true });
      // F1-style: synthesized failed status.json present, but no meta.json
      // (or unreadable) → readJob throws on the meta read.
      await writeFile(
        join(sd, 'status.json'),
        JSON.stringify({ status: 'failed', started_at: 't0', finished_at: 't1' }),
        'utf8',
      );
      // Age the dir's mtime past the 7d cutoff.
      const longAgoSec = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
      await utimes(sd, longAgoSec, longAgoSec);
      const r = await gcWorkspaceJobs(ws, { retentionDays: 7, now: Date.now() });
      expect(r.deleted).toEqual(['corrupt']);
      expect(r.warnings.some((w) => /corrupt/.test(w) && /mtime fallback/.test(w))).toBe(true);
      await expect(stat(sd)).rejects.toThrow();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable-meta dir whose mtime is fresh — F14', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      await mkdir(jobsDir(ws), { recursive: true });
      const sd = jobStateDir(ws, 'corrupt-fresh');
      await mkdir(sd, { recursive: true });
      await writeFile(join(sd, 'status.json'), JSON.stringify({ status: 'running', started_at: 't0' }), 'utf8');
      // mtime is "now" by default → fresh → not GC'd, but warning recorded.
      const r = await gcWorkspaceJobs(ws, { retentionDays: 7, now: Date.now() });
      expect(r.deleted).toEqual([]);
      expect(r.warnings.length).toBeGreaterThan(0);
      await expect(stat(sd)).resolves.toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // Coverage for `isJobLive` in the GC anchor branch: a `completing` job
  // has no finished_at, so without the isJobLive check the GC would fall
  // through to `anchor = started_at` and delete jobs that are merely
  // mid-post-flight. The contract: a `completing` job is anchored to
  // started_at + total_timeout (treat as live), matching `running`.
  it("treats 'completing' as live: anchors on started_at + ttl, not started_at", async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-jobs-'));
    try {
      // total_timeout = 1800s; backdate started_at by 1000s so:
      //   anchor (live) = started_at + 1800s ≈ now + 800s  → NOT past cutoff
      //   anchor (terminal-no-finished_at fallback) = started_at ≈ now - 1000s
      //     → 1000s old, well under retentionDays=7 → also NOT deleted with 7d
      // To distinguish, set retentionDays so cutoff falls between the two
      // anchors. Pick retention so cutoff = now - 500s:
      //   - fallback anchor (started_at = now-1000s) < cutoff(now-500s) → DELETED
      //   - live anchor    (started_at+1800s = now+800s) > cutoff       → KEPT
      const now = Date.now();
      const startedAt = new Date(now - 1000 * 1000).toISOString();
      await createJobState({
        workspaceDir: ws,
        id: 'comp',
        meta: makeMeta('comp', { started_at: startedAt, total_timeout_seconds: 1800 }),
      });
      await writeStatus(jobStateDir(ws, 'comp'), { status: 'completing', started_at: startedAt });
      // retentionDays expressed as fraction of a day so cutoff = now - 500s
      const retentionDays = 500 / (24 * 3600);
      const r = await gcWorkspaceJobs(ws, { retentionDays, now });
      expect(r.deleted).toEqual([]);
      await expect(stat(jobStateDir(ws, 'comp'))).resolves.toBeDefined();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

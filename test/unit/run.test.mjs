import { describe, it, expect, vi } from 'vitest';
import { runOne } from '../../scripts/lib/run.mjs';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

function fakeProc() {
  const ee = /** @type {any} */ (new EventEmitter());
  ee.stdout = new EventEmitter();
  /** @type {any} */ (ee.stdout).setEncoding = () => {};
  ee.stderr = new EventEmitter();
  ee.kill = () => true;
  setImmediate(() => {
    /** @type {any} */ (ee.stdout).emit('data', '');
    ee.emit('exit', 0, null);
  });
  return ee;
}

/**
 * Fake proc that emits a stderr line, no stdout, then exits non-zero.
 * Mirrors cursor-agent's behavior on a rejected `--model` argument.
 *
 * @param {string} stderrText
 * @param {number} [exitCode]
 */
function fakeProcStderrFail(stderrText, exitCode = 1) {
  const ee = /** @type {any} */ (new EventEmitter());
  ee.stdout = new EventEmitter();
  /** @type {any} */ (ee.stdout).setEncoding = () => {};
  ee.stderr = new EventEmitter();
  ee.kill = () => true;
  setImmediate(() => {
    /** @type {any} */ (ee.stderr).emit('data', Buffer.from(stderrText, 'utf8'));
    ee.emit('exit', exitCode, null);
  });
  return ee;
}

describe('runOne — cwd threading', () => {
  it('forwards cwd to spawn when provided', async () => {
    const seen = /** @type {{ cwd?: string }[]} */ ([]);
    const fakeSpawn = vi.fn((_cmd, _args, opts) => {
      seen.push({ cwd: opts?.cwd });
      return fakeProc();
    });
    await runOne({
      command: 'delegate',
      model: 'm',
      tier: 'balanced',
      vars: { TASK: 'noop', REPO_GUIDANCE: '' },
      timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
      workspaceDir: '/tmp/ws',
      cwd: '/tmp/wt',
      _spawn: /** @type {any} */ (fakeSpawn),
    });
    expect(seen[0]?.cwd).toBe('/tmp/wt');
  });

  it('omits cwd from spawn opts when not provided (preserves v0.2 behavior)', async () => {
    const seen = /** @type {Record<string, unknown>[]} */ ([]);
    const fakeSpawn = vi.fn((_cmd, _args, opts) => {
      seen.push(opts ?? {});
      return fakeProc();
    });
    await runOne({
      command: 'delegate',
      model: 'm',
      tier: 'balanced',
      vars: { TASK: 'noop', REPO_GUIDANCE: '' },
      timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
      workspaceDir: '/tmp/ws',
      _spawn: /** @type {any} */ (fakeSpawn),
    });
    expect(seen[0]).not.toHaveProperty('cwd');
  });

  it('spawns cursor-agent with detached: true so the child leads its own process group (ROI-60)', async () => {
    const seen = /** @type {Record<string, unknown>[]} */ ([]);
    const fakeSpawn = vi.fn((_cmd, _args, opts) => {
      seen.push(opts ?? {});
      return fakeProc();
    });
    await runOne({
      command: 'delegate',
      model: 'm',
      tier: 'balanced',
      vars: { TASK: 'noop', REPO_GUIDANCE: '' },
      timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
      workspaceDir: '/tmp/ws',
      _spawn: /** @type {any} */ (fakeSpawn),
    });
    expect(seen[0]?.detached).toBe(true);
  });
});

describe('runOne — stderr surfacing on internal failure', () => {
  it('folds stderr tail into run.error.message when child exits non-zero with no stream events', async () => {
    const stderrText = 'Cannot use this model: grok-4-20-thinking. Available models: ...';
    const fakeSpawn = vi.fn(() => fakeProcStderrFail(stderrText));
    const run = await runOne({
      command: 'review',
      model: 'grok-4-20-thinking',
      tier: 'reasoning',
      vars: { SCOPE: 'diff: main...HEAD', REPO_GUIDANCE: '' },
      timeouts: { silence_timeout_seconds: 5, total_timeout_seconds: 10 },
      workspaceDir: '/tmp/ws',
      _spawn: /** @type {any} */ (fakeSpawn),
    });
    expect(run.status).toBe('failed');
    expect(run.exit_reason).toBe('internal');
    expect(run.error?.code).toBe('internal');
    expect(run.error?.message).toContain('Cannot use this model: grok-4-20-thinking');
  });

  it('caps surfaced stderr to the trailing 500 chars', async () => {
    const stderrText = `${'x'.repeat(2000)}TAIL_MARKER_END`;
    const fakeSpawn = vi.fn(() => fakeProcStderrFail(stderrText));
    const run = await runOne({
      command: 'review',
      model: 'm',
      tier: 'reasoning',
      vars: { SCOPE: '', REPO_GUIDANCE: '' },
      timeouts: { silence_timeout_seconds: 5, total_timeout_seconds: 10 },
      workspaceDir: '/tmp/ws',
      _spawn: /** @type {any} */ (fakeSpawn),
    });
    expect(run.error?.message?.length).toBeLessThanOrEqual(500);
    expect(run.error?.message).toContain('TAIL_MARKER_END');
  });
});

/**
 * Fake spawn that emits a single tool_call event then exits 0.
 * Lets us assert tee writes without invoking real cursor-agent.
 */
function fakeSpawnTee() {
  return () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const listeners = { exit: /** @type {Function[]} */ ([]), error: /** @type {Function[]} */ ([]) };
    const proc = {
      stdout,
      stderr,
      stdin,
      pid: 12345,
      kill: () => true,
      /** @param {string} event @param {Function} fn */
      on(event, fn) {
        listeners[/** @type {keyof typeof listeners} */ (event)]?.push(fn);
        return proc;
      },
      /** @param {string} event @param {Function} fn */
      once(event, fn) {
        listeners[/** @type {keyof typeof listeners} */ (event)]?.push(fn);
        return proc;
      },
      removeListener() {
        return proc;
      },
    };
    setTimeout(() => {
      stdout.push(
        '{"type":"result","subtype":"success","session_id":"s1","is_error":false,"duration_ms":10,"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n',
      );
      stderr.push('warn-text\n');
      stdout.push(null);
      stderr.push(null);
      for (const fn of listeners.exit) fn(0, null);
    }, 10);
    return /** @type {any} */ (proc);
  };
}

describe('runSolo — enabledAdapters', () => {
  /**
   * Build a fresh module graph with loadMergedCatalog mocked so we can
   * assert which adapter list it receives. Returns the spy and a runSolo
   * bound to the refreshed module.
   *
   * @param {string[] | undefined} allRegistered  simulated listAdapters() return
   */
  async function freshRunSoloWithCatalogSpy(allRegistered = ['cursor', 'codex', 'gemini']) {
    vi.resetModules();
    /** @type {string[] | undefined} */
    let capturedAdapters;
    vi.doMock('../../scripts/lib/models.mjs', async () => {
      const actual = /** @type {typeof import('../../scripts/lib/models.mjs')} */ (
        await vi.importActual('../../scripts/lib/models.mjs')
      );
      return {
        ...actual,
        loadMergedCatalog: vi.fn(async (adapters) => {
          capturedAdapters = adapters;
          return actual.loadMergedCatalog(adapters);
        }),
      };
    });
    vi.doMock('../../scripts/lib/adapters/registry.mjs', async () => {
      const actual = /** @type {typeof import('../../scripts/lib/adapters/registry.mjs')} */ (
        await vi.importActual('../../scripts/lib/adapters/registry.mjs')
      );
      return {
        ...actual,
        listAdapters: vi.fn(() => allRegistered),
      };
    });
    const { runSolo: freshRunSolo } = await import('../../scripts/lib/run.mjs');
    return { freshRunSolo, getCaptured: () => capturedAdapters };
  }

  it('passes enabledAdapters to loadMergedCatalog when provided', async () => {
    const { freshRunSolo, getCaptured } = await freshRunSoloWithCatalogSpy();
    // Use a tier/count combo that resolves against the real cursor catalog.
    try {
      await freshRunSolo({
        command: 'advise',
        tier: 'balanced',
        vars: { QUESTION: 'test', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
        enabledAdapters: ['cursor'],
      });
    } catch {
      // runOne will fail (no real spawn) — that's fine; we only need
      // loadMergedCatalog to have been called with the right argument.
    }
    expect(getCaptured()).toEqual(['cursor']);
    vi.resetModules();
  });

  it('falls back to listAdapters() when enabledAdapters is omitted', async () => {
    const { freshRunSolo, getCaptured } = await freshRunSoloWithCatalogSpy(['cursor', 'codex', 'gemini']);
    try {
      await freshRunSolo({
        command: 'advise',
        tier: 'balanced',
        vars: { QUESTION: 'test', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
        // no enabledAdapters
      });
    } catch {
      /* spawn will fail — we only care about the catalog call */
    }
    expect(getCaptured()).toEqual(['cursor', 'codex', 'gemini']);
    vi.resetModules();
  });

  it('falls back to listAdapters() when enabledAdapters is empty', async () => {
    const { freshRunSolo, getCaptured } = await freshRunSoloWithCatalogSpy(['cursor', 'codex', 'gemini']);
    try {
      await freshRunSolo({
        command: 'advise',
        tier: 'balanced',
        vars: { QUESTION: 'test', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 1, total_timeout_seconds: 1 },
        enabledAdapters: [],
      });
    } catch {
      /* spawn will fail — we only care about the catalog call */
    }
    expect(getCaptured()).toEqual(['cursor', 'codex', 'gemini']);
    vi.resetModules();
  });
});

describe('runOne tee', () => {
  it('writes stdout and stderr chunks to the tee paths when provided', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-run-tee-'));
    try {
      const stdoutPath = join(ws, 'tee.stdout');
      const stderrPath = join(ws, 'tee.stderr');
      const run = await runOne({
        command: 'delegate',
        model: 'auto-sonnet-4-6',
        tier: 'balanced',
        timeouts: { silence_timeout_seconds: 10, total_timeout_seconds: 30 },
        workspaceDir: ws,
        tee: { stdoutPath, stderrPath },
        _spawn: fakeSpawnTee(),
      });
      expect(run.status).toBe('completed');
      const teedOut = await readFile(stdoutPath, 'utf8');
      const teedErr = await readFile(stderrPath, 'utf8');
      expect(teedOut).toMatch(/"type":"result"/);
      expect(teedErr).toMatch(/warn-text/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('invokes onChildSpawned with the child proc immediately after spawn', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-run-tee-'));
    try {
      /** @type {any} */
      let captured;
      await runOne({
        command: 'delegate',
        model: 'auto-sonnet-4-6',
        tier: 'balanced',
        timeouts: { silence_timeout_seconds: 10, total_timeout_seconds: 30 },
        workspaceDir: ws,
        onChildSpawned: (proc) => {
          captured = proc;
        },
        _spawn: fakeSpawnTee(),
      });
      expect(captured).toBeDefined();
      expect(captured.pid).toBe(12345);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('runOne — active-runs registry', () => {
  it('registers an active run during the call and unregisters on completion', async () => {
    const { listActiveRuns, activeRunsDir } = await import('../../scripts/lib/active-runs.mjs');
    const { readdirSync, readFileSync } = await import('node:fs');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      /** @type {Array<import('../../scripts/lib/active-runs.mjs').ActiveRunMeta>} */
      let midRun = [];
      const spawnFn = vi.fn(() => {
        // spawnFn fires synchronously between register and exit; sample
        // the registry directly from disk.
        try {
          const dir = activeRunsDir(ws);
          const files = readdirSync(dir);
          midRun = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
        } catch {
          midRun = [];
        }
        return fakeProc();
      });

      await runOne({
        command: 'review',
        model: 'm',
        tier: 'reasoning',
        timeouts: { silence_timeout_seconds: 5, total_timeout_seconds: 5 },
        workspaceDir: ws,
        _spawn: /** @type {any} */ (spawnFn),
      });

      expect(midRun).toHaveLength(1);
      expect(midRun[0]).toMatchObject({
        command: 'review',
        model: 'm',
        // Unknown model id 'm' falls through every adapter catalog and lands
        // on cursor — same routing the user sees when an alias like 'agy'
        // is forwarded as a model id. Persisting the resolved adapter is
        // what makes that mismatch visible in /cursed:status.
        adapter: 'cursor',
        tier: 'reasoning',
        pid: process.pid,
      });
      expect(typeof midRun[0].id).toBe('string');
      expect(midRun[0].id).toMatch(/^[0-9a-f]{16}$/);

      const after = await listActiveRuns(ws);
      expect(after).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('skips registration when tee is set (background-worker context)', async () => {
    const { activeRunsDir } = await import('../../scripts/lib/active-runs.mjs');
    const { existsSync, readdirSync } = await import('node:fs');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const stdoutPath = join(ws, 'tee.stdout');
      const stderrPath = join(ws, 'tee.stderr');
      /** @type {string[]} */
      let midRunFiles = [];
      const spawnFn = vi.fn(() => {
        try {
          midRunFiles = readdirSync(activeRunsDir(ws));
        } catch {
          midRunFiles = [];
        }
        return fakeProc();
      });

      await runOne({
        command: 'delegate',
        model: 'm',
        tier: 'balanced',
        timeouts: { silence_timeout_seconds: 5, total_timeout_seconds: 5 },
        workspaceDir: ws,
        tee: { stdoutPath, stderrPath },
        _spawn: /** @type {any} */ (spawnFn),
      });

      expect(midRunFiles).toEqual([]);
      // active-runs dir was never even created.
      expect(existsSync(activeRunsDir(ws))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('unregisters even when the spawn fails synchronously', async () => {
    const { listActiveRuns } = await import('../../scripts/lib/active-runs.mjs');
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const spawnFn = vi.fn(() => {
        throw new Error('boom');
      });

      await expect(
        runOne({
          command: 'advise',
          model: 'm',
          tier: 'balanced',
          timeouts: { silence_timeout_seconds: 5, total_timeout_seconds: 5 },
          workspaceDir: ws,
          _spawn: /** @type {any} */ (spawnFn),
        }),
      ).rejects.toThrow(/boom/);

      const after = await listActiveRuns(ws);
      expect(after).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

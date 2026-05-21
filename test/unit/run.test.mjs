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

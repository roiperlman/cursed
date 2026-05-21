import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOne } from '../../scripts/lib/run.mjs';

/**
 * Build a fakeSpawn factory whose returned EventEmitter emits a sequence
 * of NDJSON stdout chunks then exits. Scheduling the emits inside the
 * factory (not before runOne is called) ensures runOne's pre-spawn awaits
 * have completed and the watchdog's `proc.once('exit', …)` listener is in
 * place before the exit emit fires.
 *
 * @param {string[]} lines  Stream lines to emit. Use `[]` for no-output (failure).
 * @param {{ exitCode?: number, stderr?: string }} [opts]
 */
function fakeSpawnFactory(lines, opts = {}) {
  return vi.fn(() => {
    const ee = /** @type {any} */ (new EventEmitter());
    ee.stdout = new EventEmitter();
    /** @type {any} */ (ee.stdout).setEncoding = () => {};
    ee.stderr = new EventEmitter();
    ee.kill = () => true;
    setImmediate(() => {
      for (const line of lines) {
        /** @type {any} */ (ee.stdout).emit('data', `${line}\n`);
      }
      if (opts.stderr) {
        /** @type {any} */ (ee.stderr).emit('data', Buffer.from(opts.stderr, 'utf8'));
      }
      // Defer exit one more tick so any async data-handler microtasks
      // (transcript.writeLine + per-line tickProgress) have a chance to
      // drain before the watchdog resolves and runOne returns.
      setImmediate(() => ee.emit('exit', opts.exitCode ?? 0, null));
    });
    return ee;
  });
}

describe('runOne — notify hook', () => {
  it('emits entry+exit log + a progress tick per recognized stream event', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'cursed-notify-'));
    try {
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: {} } } }),
        JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: { shellToolCall: { args: {} } } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          duration_ms: 12,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ];

      /** @type {Array<{ level: string, data: unknown, logger?: string }>} */
      const logs = [];
      /** @type {Array<{ progress: number, total?: number, message?: string }>} */
      const progress = [];
      /** @type {import('../../scripts/lib/types.d.ts').RunNotifier} */
      const notify = {
        log: (level, data, logger) => logs.push({ level, data, logger }),
        progress: (p, total, message) => progress.push({ progress: p, total, message }),
      };

      const run = await runOne({
        command: 'advise',
        model: 'm-1',
        tier: 'fast',
        vars: { QUESTION: 'noop', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 2, total_timeout_seconds: 2 },
        workspaceDir: wsDir,
        notify,
        _spawn: /** @type {any} */ (fakeSpawnFactory(lines)),
      });

      expect(run.status).toBe('completed');
      // runOne supplies wall-clock duration (Phase 1.5 — parsers no longer
      // surface duration_ms from stream events). Always non-negative.
      expect(run.duration_ms).toBeGreaterThanOrEqual(0);

      // Logs: one info at entry (phase=start), one info at exit (phase=end).
      expect(logs.length).toBe(2);
      expect(logs[0].level).toBe('info');
      expect(logs[0].data).toMatchObject({ phase: 'start', command: 'advise', model: 'm-1' });
      expect(logs[1].level).toBe('info');
      expect(logs[1].data).toMatchObject({ phase: 'end', command: 'advise', status: 'completed' });

      // Progress: 1 entry tick + 5 stream events (system_init, tool_start,
      // tool_done, assistant, result) + 1 exit tick = 7 monotonically
      // increasing counts.
      expect(progress.length).toBe(7);
      expect(progress.map((p) => p.progress)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(progress[0].message).toContain('starting on m-1');
      expect(progress[1].message).toContain('session started');
      expect(progress[2].message).toContain('shellToolCall');
      expect(progress[3].message).toContain('tool done');
      expect(progress[4].message).toContain('model responded');
      expect(progress[5].message).toContain('completed');
      expect(progress[6].message).toContain('advise: completed');
      // total omitted (free-running counter per RunNotifier.progress JSDoc).
      for (const p of progress) expect(p.total).toBeUndefined();
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });

  it('emits a warning log + completion progress on failure', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'cursed-notify-fail-'));
    try {
      /** @type {Array<{ level: string, data: unknown }>} */
      const logs = [];
      /** @type {import('../../scripts/lib/types.d.ts').RunNotifier} */
      const notify = {
        log: (level, data) => logs.push({ level, data }),
        progress: () => {},
      };

      const run = await runOne({
        command: 'advise',
        model: 'm-1',
        tier: 'fast',
        vars: { QUESTION: 'noop', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 2, total_timeout_seconds: 2 },
        workspaceDir: wsDir,
        notify,
        _spawn: /** @type {any} */ (fakeSpawnFactory([], { exitCode: 1, stderr: 'boom\n' })),
      });

      expect(run.status).toBe('failed');
      expect(logs.length).toBe(2);
      expect(logs[0].level).toBe('info'); // entry
      expect(logs[1].level).toBe('warning'); // exit (failed)
      expect(logs[1].data).toMatchObject({ phase: 'end', status: 'failed' });
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });

  it('survives a notify implementation that throws on every call', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'cursed-notify-throwy-'));
    try {
      /** @type {import('../../scripts/lib/types.d.ts').RunNotifier} */
      const notify = {
        log: () => {
          throw new Error('client crash');
        },
        progress: () => {
          throw new Error('client crash');
        },
      };

      const run = await runOne({
        command: 'advise',
        model: 'm-1',
        tier: 'fast',
        vars: { QUESTION: 'noop', CONTEXT: '' },
        timeouts: { silence_timeout_seconds: 2, total_timeout_seconds: 2 },
        workspaceDir: wsDir,
        notify,
        _spawn: /** @type {any} */ (fakeSpawnFactory([])),
      });

      // Despite both notify functions throwing on every call, the run completed.
      expect(run.status).toBe('completed');
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });
});

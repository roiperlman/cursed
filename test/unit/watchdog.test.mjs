import { describe, it, expect, vi, afterEach } from 'vitest';
import { Watchdog } from '../../scripts/lib/watchdog.mjs';
import { EventEmitter } from 'node:events';

class FakeProc extends EventEmitter {
  /**
   * @param {{ ignoreSigterm?: boolean }} [options]
   */
  constructor({ ignoreSigterm = false } = {}) {
    super();
    /** @type {string[]} */
    this.signals = [];
    this.killed = false;
    this.ignoreSigterm = ignoreSigterm;
  }
  /**
   * @param {string} sig
   * @returns {boolean}
   */
  kill(sig) {
    this.signals.push(sig);
    if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !this.ignoreSigterm)) {
      this.killed = true;
      setImmediate(() => this.emit('exit', sig === 'SIGTERM' ? 143 : 137, sig));
    }
    return true;
  }
}

/**
 * @param {FakeProc} proc
 * @returns {import("node:child_process").ChildProcess}
 */
function asChildProcess(proc) {
  return /** @type {import("node:child_process").ChildProcess} */ (/** @type {unknown} */ (proc));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Watchdog', () => {
  it('fires silence timeout when no events arrive', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 100, totalMs: 10_000 });
    const p = w.run();
    vi.advanceTimersByTime(150);
    // allow setImmediate callback for 'exit'
    await vi.advanceTimersByTimeAsync(10);
    const r = await p;
    expect(r.reason).toBe('stall');
    expect(proc.signals[0]).toBe('SIGTERM');
  });

  it('escalates to SIGKILL if SIGTERM is ignored for >5s', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc({ ignoreSigterm: true });
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 100, totalMs: 10_000 });
    const p = w.run();
    await vi.advanceTimersByTimeAsync(150);
    expect(proc.signals).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(6_000);
    const r = await p;
    expect(proc.signals).toContain('SIGKILL');
    expect(r.reason).toBe('stall');
  });

  it('resets silence timer on event', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 100, totalMs: 10_000 });
    const p = w.run();
    await vi.advanceTimersByTimeAsync(80);
    w.onEvent();
    await vi.advanceTimersByTimeAsync(80);
    expect(proc.signals).toEqual([]);
    // fire exit to resolve
    proc.emit('exit', 0, null);
    const r = await p;
    expect(r.reason).toBe('completed');
  });

  it('fires total-timeout even if events keep arriving', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 1_000, totalMs: 500 });
    const p = w.run();
    // keep resetting silence
    for (let t = 0; t < 600; t += 50) {
      await vi.advanceTimersByTimeAsync(50);
      w.onEvent();
    }
    const r = await p;
    expect(r.reason).toBe('total_timeout');
    expect(proc.signals).toContain('SIGTERM');
  });

  it('returns completed on clean exit', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 1_000, totalMs: 10_000 });
    const p = w.run();
    await vi.advanceTimersByTimeAsync(50);
    proc.emit('exit', 0, null);
    const r = await p;
    expect(r.reason).toBe('completed');
    expect(r.exitCode).toBe(0);
  });

  it('maps non-zero exit (no watchdog fire) to internal, not completed', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 1_000, totalMs: 10_000 });
    const p = w.run();
    await vi.advanceTimersByTimeAsync(50);
    proc.emit('exit', 1, null);
    const r = await p;
    expect(r.reason).toBe('internal');
    expect(r.exitCode).toBe(1);
  });

  it('maps signal-kill (no watchdog fire) to internal, not completed', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 1_000, totalMs: 10_000 });
    const p = w.run();
    await vi.advanceTimersByTimeAsync(50);
    proc.emit('exit', null, 'SIGTERM');
    const r = await p;
    expect(r.reason).toBe('internal');
    expect(r.signal).toBe('SIGTERM');
  });

  it('cancel() sends SIGTERM and resolves with reason=cancelled', async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    const w = new Watchdog(asChildProcess(proc), { silenceMs: 1_000, totalMs: 10_000 });
    const p = w.run();
    w.cancel();
    await vi.advanceTimersByTimeAsync(10);
    const r = await p;
    expect(r.reason).toBe('cancelled');
  });
});

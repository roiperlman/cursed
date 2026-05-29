import { killProcessTree } from './proc.mjs';

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {import("./types.d.ts").WatchdogResult} WatchdogResult */
/** @typedef {import("./types.d.ts").ExitReason} ExitReason */

/**
 * Watchdog manages two timers for a spawned cursor-agent subprocess:
 *  - silenceMs: resets on every call to onEvent(); firing means "no progress".
 *  - totalMs:   starts at run(); fires regardless of events.
 * On either fire: SIGTERM, wait 5s, SIGKILL if still alive.
 *
 * Usage:
 *   const w = new Watchdog(proc, { silenceMs: 120_000, totalMs: 1_200_000 });
 *   const { reason, exitCode, signal } = await w.run();
 *   // Call w.onEvent() from the stream parser every time a line is received.
 */
export class Watchdog {
  /**
   * @param {ChildProcess} proc
   * @param {{ silenceMs: number; totalMs: number }} timeouts
   */
  constructor(proc, { silenceMs, totalMs }) {
    /** @type {ChildProcess} */
    this.proc = proc;
    /** @type {number} */
    this.silenceMs = silenceMs;
    /** @type {number} */
    this.totalMs = totalMs;
    /** @type {NodeJS.Timeout | null} */
    this._silenceT = null;
    /** @type {NodeJS.Timeout | null} */
    this._totalT = null;
    /** @type {NodeJS.Timeout | null} */
    this._killT = null;
    /** @type {ExitReason | null} */
    this._reason = null;
    /** @type {((result: WatchdogResult) => void) | null} */
    this._resolve = null;
    /** @type {boolean} */
    this._done = false;
  }

  /**
   * Begin watching the child process. Resolves with the WatchdogResult once
   * the process exits (whether on its own or after a watchdog fire).
   *
   * @returns {Promise<WatchdogResult>}
   */
  run() {
    return new Promise((resolve) => {
      this._resolve = resolve;

      this.proc.once('exit', (code, signal) => {
        this._clearTimers();
        if (this._done) return; // watchdog already decided
        // Non-zero exit (or signal-kill) without a watchdog fire is a child crash —
        // map to 'internal' so callers don't mistake it for a clean completion.
        const reason = this._reason ?? (code === 0 && signal === null ? 'completed' : 'internal');
        this._finish({ reason, exitCode: code, signal });
      });

      // 'error' fires when the binary is not found (ENOENT) or spawn fails for
      // other OS reasons. Without a handler this becomes an uncaught exception
      // that crashes the MCP server process. Map it to 'internal' so runOne
      // returns a failed RunRecord instead of killing the server.
      this.proc.once('error', () => {
        this._clearTimers();
        if (this._done) return;
        this._finish({ reason: 'internal', exitCode: null, signal: null });
      });

      this._resetSilence();
      this._totalT = setTimeout(() => this._fire('total_timeout'), this.totalMs);
    });
  }

  /** Reset the silence timer. Call from the stream parser on each line. */
  onEvent() {
    if (this._done) return;
    this._resetSilence();
  }

  /** Cancel the run from outside (e.g. user ^C). */
  cancel() {
    this._fire('cancelled');
  }

  _resetSilence() {
    if (this._silenceT) clearTimeout(this._silenceT);
    this._silenceT = setTimeout(() => this._fire('stall'), this.silenceMs);
  }

  _clearTimers() {
    if (this._silenceT) clearTimeout(this._silenceT);
    if (this._totalT) clearTimeout(this._totalT);
    if (this._killT) clearTimeout(this._killT);
    this._silenceT = this._totalT = this._killT = null;
  }

  /**
   * @param {ExitReason} reason
   */
  _fire(reason) {
    if (this._done || this._reason) return;
    this._reason = reason;
    this._clearTimers();
    // ROI-60: kill the process group, not just the leader. cursor-agent
    // spawns shell tools / LSPs while running its prompt; without a group
    // signal those descendants reparent to launchd and keep running.
    killProcessTree(this.proc, 'SIGTERM');
    // If the process doesn't exit within 5s, SIGKILL the whole group.
    this._killT = setTimeout(() => {
      killProcessTree(this.proc, 'SIGKILL');
    }, 5_000);
    // Wait for 'exit' to actually resolve — the 'exit' handler in run() will call _finish.
    this.proc.once('exit', (code, signal) => {
      if (this._done) return;
      this._finish({ reason: this._reason ?? reason, exitCode: code, signal });
    });
  }

  /**
   * @param {WatchdogResult} result
   */
  _finish(result) {
    if (this._done) return;
    this._done = true;
    this._clearTimers();
    if (this._resolve) this._resolve(result);
  }
}

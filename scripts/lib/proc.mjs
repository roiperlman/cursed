/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

/**
 * Signal a child cursor-agent process and (if it was spawned `detached: true`)
 * every descendant in its process group.
 *
 * Why both: cursor-agent's Node entrypoint can `exec()` shell tools, LSPs, and
 * other helpers while running an agentic prompt. A bare `proc.kill(sig)` only
 * targets the cursor-agent leader; its descendants reparent to launchd/init
 * and keep running ("runaway processes"). When the leader is spawned with
 * `detached: true` it becomes its own process-group leader (pgid === pid),
 * and `process.kill(-pid, sig)` delivers the signal to every member of the
 * group at once.
 *
 * We always also call `proc.kill(sig)` so:
 *   - test FakeProcs (no real pid, but with a `.kill` spy) still observe the
 *     call and pass their assertions;
 *   - a non-detached child still gets the leader signal even if the group
 *     kill is rejected as ESRCH/EPERM.
 *
 * Both branches swallow errors: at this point the run is being torn down and
 * the only thing worse than the runaway is an exception ripping past the
 * watchdog or cancel-poll.
 *
 * @param {ChildProcess | null | undefined} proc
 * @param {NodeJS.Signals | number} signal
 */
export function killProcessTree(proc, signal) {
  if (!proc) return;
  try {
    proc.kill(signal);
  } catch {
    /* leader already gone, or no .kill on a fake — fall through to the group kill */
  }
  // process.kill(-pid, sig) addresses the process group. Only meaningful when
  // proc.pid is a real, positive PID; skipping it for falsy/zero/negative pids
  // avoids accidental signal delivery to PID 1 or to an unrelated group on a
  // wrapped/PID-reused test value.
  if (typeof proc.pid === 'number' && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      /* ESRCH: group empty/gone. EPERM: not a group leader (no detached:true). Either way, nothing more to do. */
    }
  }
}

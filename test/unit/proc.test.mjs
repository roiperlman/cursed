import { describe, it, expect, vi, afterEach } from 'vitest';
import { killProcessTree } from '../../scripts/lib/proc.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('killProcessTree', () => {
  it('no-ops when proc is null or undefined', () => {
    expect(() => killProcessTree(null, 'SIGTERM')).not.toThrow();
    expect(() => killProcessTree(undefined, 'SIGTERM')).not.toThrow();
  });

  it('signals the leader and the group when proc has a real pid', () => {
    // Spy on process.kill so we can detect the group-signal call without
    // actually nuking anything. The real implementation runs proc.kill first
    // (the leader signal), then process.kill(-pid) (the group signal).
    const procKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const leaderKill = vi.fn(() => true);
    /** @type {any} */
    const proc = { pid: 4242, kill: leaderKill };

    killProcessTree(proc, 'SIGTERM');

    expect(leaderKill).toHaveBeenCalledWith('SIGTERM');
    expect(procKillSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('skips the group kill when proc has no positive pid (fake/test procs)', () => {
    const procKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const leaderKill = vi.fn(() => true);
    /** @type {any} */
    const proc = { kill: leaderKill }; // no pid

    killProcessTree(proc, 'SIGTERM');

    expect(leaderKill).toHaveBeenCalledWith('SIGTERM');
    expect(procKillSpy).not.toHaveBeenCalled();
  });

  it('swallows errors from both leader and group kills', () => {
    const procKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const leaderKill = vi.fn(() => {
      throw new Error('already dead');
    });
    /** @type {any} */
    const proc = { pid: 1234, kill: leaderKill };

    expect(() => killProcessTree(proc, 'SIGKILL')).not.toThrow();
    expect(leaderKill).toHaveBeenCalledWith('SIGKILL');
    expect(procKillSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('skips group kill for non-positive pids (0, negative)', () => {
    const procKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const leaderKill = vi.fn(() => true);
    /** @type {any} */
    const proc0 = { pid: 0, kill: leaderKill };
    killProcessTree(proc0, 'SIGTERM');
    expect(procKillSpy).not.toHaveBeenCalled();

    /** @type {any} */
    const procNeg = { pid: -1, kill: leaderKill };
    killProcessTree(procNeg, 'SIGTERM');
    expect(procKillSpy).not.toHaveBeenCalled();
  });
});

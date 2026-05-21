import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-delegate-bg-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: dir });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('delegate({ background: true })', () => {
  it('rejects background without worktree', async () => {
    const { invokeDelegate } = await import('./helpers/delegate-harness.mjs');
    await expect(invokeDelegate({ task: 'noop', background: true })).rejects.toThrow(/background requires worktree/);
  });

  it('spawns a detached worker and returns BackgroundJobHandle', async () => {
    const repo = await freshRepo();
    const origCwd = process.cwd();
    process.chdir(repo);
    try {
      /** @type {any[]} */
      const spawnCalls = [];
      /** @type {any[]} */
      const spawnedChildren = [];
      const fakeSpawn = (/** @type {any} */ cmd, /** @type {any} */ args, /** @type {any} */ opts) => {
        spawnCalls.push({ cmd, args, opts });
        const child = { pid: 7777, unref: vi.fn(), on() {}, once() {}, kill() {} };
        spawnedChildren.push(child);
        return child;
      };
      const { invokeDelegate } = await import('./helpers/delegate-harness.mjs');
      const result = await invokeDelegate(
        { task: 'noop', worktree: 'feat-bg', background: true },
        { _spawn: fakeSpawn },
      );
      expect(result.background).toBe(true);
      expect(result.job_id).toBe('feat-bg');
      expect(result.status).toBe('running');
      expect(result.worktree.branch).toBe('feat-bg');
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].opts.detached).toBe(true);
      expect(spawnCalls[0].args[0]).toMatch(/cursed-job\.mjs$/);
      expect(spawnedChildren[0].unref).toHaveBeenCalled();
      const stateDir = result.state_dir;
      await expect(stat(join(stateDir, 'meta.json'))).resolves.toBeDefined();
      await expect(stat(join(stateDir, 'status.json'))).resolves.toBeDefined();
    } finally {
      process.chdir(origCwd);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("registers an 'error' listener so a failed spawn does not crash the server and flips state to terminal", async () => {
    const repo = await freshRepo();
    const origCwd = process.cwd();
    process.chdir(repo);
    try {
      /** @type {Array<(err: Error) => void>} */
      const errorListeners = [];
      const fakeSpawn = (/** @type {any} */ _cmd, /** @type {any} */ _args, /** @type {any} */ _opts) => ({
        pid: 8888,
        unref: vi.fn(),
        /** @param {string} event @param {(err: Error) => void} fn */
        on(event, fn) {
          if (event === 'error') errorListeners.push(fn);
        },
        once() {},
        kill() {},
      });
      const { invokeDelegate } = await import('./helpers/delegate-harness.mjs');
      const result = await invokeDelegate(
        { task: 'noop', worktree: 'feat-err', background: true },
        { _spawn: fakeSpawn },
      );
      expect(result.background).toBe(true);
      // An error listener was registered on the spawned child.
      expect(errorListeners.length).toBe(1);
      // Firing it must not throw.
      expect(() => errorListeners[0](new Error('ENOENT: worker missing'))).not.toThrow();
      // The handler kicks off a fire-and-forget async block — wait briefly
      // for it to flush status.json + result.json.
      const stateDir = result.state_dir;
      /** @type {{ status: string, finished_at?: string } | null} */
      let finalStatus = null;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          const s = JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8'));
          if (s.status === 'failed') {
            finalStatus = s;
            break;
          }
        } catch {
          /* not yet readable */
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(finalStatus?.status).toBe('failed');
      expect(finalStatus?.finished_at).toBeDefined();
      const synthesized = JSON.parse(await readFile(join(stateDir, 'result.json'), 'utf8'));
      expect(synthesized.run.error.code).toBe('internal');
      expect(synthesized.run.error.message).toMatch(/ENOENT: worker missing/);
      expect(synthesized.worktree.cleanup_status).toBe('kept-due-to-failure');
    } finally {
      process.chdir(origCwd);
      await rm(repo, { recursive: true, force: true });
    }
  });
});

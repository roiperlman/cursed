import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const GATE = process.env.TESTBED_E2E === '1';

(GATE ? describe : describe.skip)('delegate background — end-to-end against real cursor-agent', () => {
  it('spawns a worker that completes a trivial task and writes result.json', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cursed-bg-e2e-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'cursed-bg-data-'));
    const orig = process.cwd();
    process.chdir(repo);
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    try {
      await pexec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      await pexec('git', ['config', 'user.email', 'test@test'], { cwd: repo });
      await pexec('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      await writeFile(join(repo, 'README.md'), 'replace ME placeholder\n');
      await pexec('git', ['add', 'README.md'], { cwd: repo });
      await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

      const mcp = await import('../../scripts/mcp/cursed-mcp.mjs');
      const handle = await mcp.__test_invokeDelegate__({
        task: 'Replace the literal text "ME" with "YOU" in README.md and commit the change.',
        worktree: 'bg-e2e',
        background: true,
      });
      expect(handle.background).toBe(true);
      expect(handle.job_id).toBe('bg-e2e');

      const sd = handle.state_dir;
      const deadline = Date.now() + 90_000;
      let terminal = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = JSON.parse(await readFile(join(sd, 'status.json'), 'utf8'));
        if (status.status !== 'running') {
          terminal = true;
          break;
        }
      }
      expect(terminal).toBe(true);
      const result = JSON.parse(await readFile(join(sd, 'result.json'), 'utf8'));
      expect(result.panel).toBe(false);
      expect(['completed', 'failed', 'cancelled']).toContain(result.run.status);
      expect(result.worktree.branch).toBe('bg-e2e');
    } finally {
      process.chdir(orig);
      delete process.env.CLAUDE_PLUGIN_DATA;
      await rm(repo, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

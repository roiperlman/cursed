import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER = resolve(REPO_ROOT, 'scripts/mcp/cursed-mcp.mjs');

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-delwt-e2e-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'baz.txt'), 'foo\n');
  await pexec('git', ['add', 'baz.txt'], { cwd: dir });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe.skipIf(!process.env.TESTBED_E2E)('integration: delegate --worktree end-to-end', () => {
  it('runs cursor-agent in an isolated worktree, retains branch on cleanup', async () => {
    const repo = await freshRepo();
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER],
      cwd: repo, // important: the MCP server reads process.cwd() for repoRoot
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'delegate',
        arguments: {
          task: 'In baz.txt, change "foo" to "bar". Commit the change with message "rename".',
          worktree: 'rename-feat',
          tier: 'balanced',
        },
      });
      expect(result.isError).toBeFalsy();
      const sc = /** @type {Record<string, any>} */ (result.structuredContent);
      expect(sc.run.status).toBe('completed');
      expect(sc.worktree).toMatchObject({
        branch: 'rename-feat',
        cleanup_status: 'removed',
      });
      // Working dir should be gone.
      await expect(access(join(repo, '.cursed', 'worktrees', 'rename-feat'))).rejects.toThrow();
      // Branch retained with the expected diff.
      const { stdout: branches } = await pexec('git', ['branch'], { cwd: repo });
      expect(branches).toMatch(/rename-feat/);
      const { stdout: diff } = await pexec('git', ['diff', 'main', 'rename-feat', '--', 'baz.txt'], { cwd: repo });
      expect(diff).toMatch(/-foo/);
      expect(diff).toMatch(/\+bar/);
    } finally {
      await client.close();
      await rm(repo, { recursive: true, force: true });
    }
  }, 180_000);
});

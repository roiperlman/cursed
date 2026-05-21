import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorktreePostFlight } from '../../scripts/lib/worktree.mjs';

const pexec = promisify(execFile);

async function freshRepoWithWorktree() {
  const repo = await mkdtemp(join(tmpdir(), 'cursed-wt-pf-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: repo });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: repo });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  const wtPath = join(repo, '.cursed', 'worktrees', 'feat-x');
  await mkdir(join(repo, '.cursed', 'worktrees'), { recursive: true });
  await pexec('git', ['worktree', 'add', wtPath, '-b', 'feat-x', 'HEAD'], { cwd: repo });
  const headSha = (await pexec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  return { repo, wtPath, headSha };
}

describe('runWorktreePostFlight', () => {
  it('removes the worktree on completed + keep:false + clean worktree', async () => {
    const { repo, wtPath, headSha } = await freshRepoWithWorktree();
    try {
      const result = await runWorktreePostFlight({
        worktreeInfo: { path: wtPath, branch: 'feat-x', base: headSha },
        runStatus: 'completed',
        keep: false,
        repoRoot: repo,
      });
      expect(result.cleanup_status).toBe('removed');
      expect(result.warnings).toEqual([]);
      expect(result.followup_commands).toEqual([
        `git diff ${headSha}..feat-x`,
        'git merge feat-x',
        'git branch -d feat-x',
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('retains the worktree on completed + keep:true', async () => {
    const { repo, wtPath, headSha } = await freshRepoWithWorktree();
    try {
      const result = await runWorktreePostFlight({
        worktreeInfo: { path: wtPath, branch: 'feat-x', base: headSha },
        runStatus: 'completed',
        keep: true,
        repoRoot: repo,
      });
      expect(result.cleanup_status).toBe('kept-on-success');
      expect(result.followup_commands).toContain(`git worktree remove .cursed/worktrees/feat-x`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('retains the worktree on failed run', async () => {
    const { repo, wtPath, headSha } = await freshRepoWithWorktree();
    try {
      const result = await runWorktreePostFlight({
        worktreeInfo: { path: wtPath, branch: 'feat-x', base: headSha },
        runStatus: 'failed',
        keep: false,
        repoRoot: repo,
      });
      expect(result.cleanup_status).toBe('kept-due-to-failure');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the worktree + warns when uncommitted output is present', async () => {
    const { repo, wtPath, headSha } = await freshRepoWithWorktree();
    try {
      await writeFile(join(wtPath, 'uncommitted.txt'), 'work-in-progress\n');
      const result = await runWorktreePostFlight({
        worktreeInfo: { path: wtPath, branch: 'feat-x', base: headSha },
        runStatus: 'completed',
        keep: false,
        repoRoot: repo,
      });
      expect(result.cleanup_status).toBe('kept-cleanup-failed');
      expect(result.warnings.some((w) => /worktree_uncommitted_output/.test(w))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the worktree + warns when removal fails (path not a registered worktree)', async () => {
    const { repo, headSha } = await freshRepoWithWorktree();
    try {
      const bogusPath = join(repo, '.cursed', 'worktrees', 'does-not-exist');
      const result = await runWorktreePostFlight({
        worktreeInfo: { path: bogusPath, branch: 'does-not-exist', base: headSha },
        runStatus: 'completed',
        keep: false,
        repoRoot: repo,
      });
      expect(result.cleanup_status).toBe('kept-cleanup-failed');
      expect(result.warnings.some((w) => /worktree_cleanup_failed/.test(w))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

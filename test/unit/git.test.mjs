import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseDiffStat,
  gitStatusPorcelain,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitBranchExists,
  gitRevParse,
} from '../../scripts/lib/git.mjs';

const pexec = promisify(execFile);

/**
 * Build a tmp dir with `git init`, one committed file. Returns repo path.
 * Caller cleans up via `rm(path, { recursive: true, force: true })`.
 */
async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-git-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: dir });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('parseDiffStat', () => {
  it('extracts total LOC changed from git diff --stat output', () => {
    const input =
      ' scripts/lib/stream.mjs | 120 +++++++++++++++++++++----\n' +
      ' scripts/lib/watchdog.mjs |  40 +++---\n' +
      ' 2 files changed, 130 insertions(+), 30 deletions(-)\n';
    const r = parseDiffStat(input);
    expect(r.files_changed).toBe(2);
    expect(r.insertions).toBe(130);
    expect(r.deletions).toBe(30);
    expect(r.loc_touched).toBe(160);
    expect(r.file_paths).toEqual(['scripts/lib/stream.mjs', 'scripts/lib/watchdog.mjs']);
  });

  it('handles empty diff', () => {
    const r = parseDiffStat('');
    expect(r.files_changed).toBe(0);
    expect(r.loc_touched).toBe(0);
  });

  it('handles single-file single-line changes', () => {
    const input = ' README.md | 1 +\n 1 file changed, 1 insertion(+)\n';
    const r = parseDiffStat(input);
    expect(r.files_changed).toBe(1);
    expect(r.insertions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(r.file_paths).toEqual(['README.md']);
  });
});

describe('gitStatusPorcelain', () => {
  it('returns clean=true on a fresh commit', async () => {
    const repo = await freshRepo();
    try {
      const r = await gitStatusPorcelain(repo);
      expect(r.clean).toBe(true);
      expect(r.lines).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns clean=false with the dirty lines on uncommitted changes', async () => {
    const repo = await freshRepo();
    try {
      await writeFile(join(repo, 'wip.txt'), 'unstaged\n');
      const r = await gitStatusPorcelain(repo);
      expect(r.clean).toBe(false);
      expect(r.lines).toEqual(expect.arrayContaining([expect.stringMatching(/wip\.txt/)]));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('gitBranchExists', () => {
  it('returns false when branch absent', async () => {
    const repo = await freshRepo();
    try {
      expect(await gitBranchExists('feat-x', repo)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns true when branch present', async () => {
    const repo = await freshRepo();
    try {
      await pexec('git', ['branch', 'feat-x'], { cwd: repo });
      expect(await gitBranchExists('feat-x', repo)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('gitRevParse', () => {
  it('resolves HEAD to a SHA', async () => {
    const repo = await freshRepo();
    try {
      const sha = await gitRevParse('HEAD', repo);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws on a garbage ref', async () => {
    const repo = await freshRepo();
    try {
      await expect(gitRevParse('this-ref-does-not-exist', repo)).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('gitWorktreeAdd / gitWorktreeRemove', () => {
  it('creates a worktree at the requested path on a new branch off HEAD', async () => {
    const repo = await freshRepo();
    try {
      const wtDir = join(repo, '.cursed', 'worktrees', 'feat-x');
      await mkdir(join(repo, '.cursed', 'worktrees'), { recursive: true });
      await gitWorktreeAdd({ path: wtDir, branch: 'feat-x', base: 'HEAD', cwd: repo });
      const exists = await gitBranchExists('feat-x', repo);
      expect(exists).toBe(true);
      const { stdout: list } = await pexec('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
      expect(list).toMatch(/feat-x/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws on collision (branch already exists)', async () => {
    const repo = await freshRepo();
    try {
      await pexec('git', ['branch', 'feat-x'], { cwd: repo });
      const wtDir = join(repo, '.cursed', 'worktrees', 'feat-x');
      await mkdir(join(repo, '.cursed', 'worktrees'), { recursive: true });
      await expect(gitWorktreeAdd({ path: wtDir, branch: 'feat-x', base: 'HEAD', cwd: repo })).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('removes a worktree by path', async () => {
    const repo = await freshRepo();
    try {
      const wtDir = join(repo, '.cursed', 'worktrees', 'feat-y');
      await mkdir(join(repo, '.cursed', 'worktrees'), { recursive: true });
      await gitWorktreeAdd({ path: wtDir, branch: 'feat-y', base: 'HEAD', cwd: repo });
      await gitWorktreeRemove(wtDir, repo);
      const { stdout: list } = await pexec('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
      expect(list).not.toMatch(/feat-y/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

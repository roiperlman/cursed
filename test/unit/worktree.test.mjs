import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeRoot, ensureGitignoreLine, createWorktree, removeWorktree } from '../../scripts/lib/worktree.mjs';

const pexec = promisify(execFile);

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-wt-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: dir });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('worktreeRoot', () => {
  it('joins repoRoot with .cursed/worktrees', () => {
    expect(worktreeRoot('/tmp/r')).toBe('/tmp/r/.cursed/worktrees');
  });
});

describe('ensureGitignoreLine', () => {
  it('appends the line when .gitignore exists without it', async () => {
    const repo = await freshRepo();
    try {
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
      await ensureGitignoreLine(repo, '.cursed/');
      const content = await readFile(join(repo, '.gitignore'), 'utf8');
      expect(content).toBe('node_modules/\n.cursed/\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op when the line is already present', async () => {
    const repo = await freshRepo();
    try {
      await writeFile(join(repo, '.gitignore'), '.cursed/\nnode_modules/\n');
      await ensureGitignoreLine(repo, '.cursed/');
      const content = await readFile(join(repo, '.gitignore'), 'utf8');
      expect(content).toBe('.cursed/\nnode_modules/\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op when .gitignore does not exist (does not create it)', async () => {
    const repo = await freshRepo();
    try {
      await ensureGitignoreLine(repo, '.cursed/');
      await expect(access(join(repo, '.gitignore'))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('handles a .gitignore that does not end with a newline', async () => {
    const repo = await freshRepo();
    try {
      await writeFile(join(repo, '.gitignore'), 'node_modules/'); // no trailing \n
      await ensureGitignoreLine(repo, '.cursed/');
      const content = await readFile(join(repo, '.gitignore'), 'utf8');
      expect(content).toBe('node_modules/\n.cursed/\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('createWorktree / removeWorktree', () => {
  it('creates a worktree directory under .cursed/worktrees and returns metadata', async () => {
    const repo = await freshRepo();
    try {
      const r = await createWorktree({ name: 'feat-x', base: 'HEAD', repoRoot: repo });
      expect(r.path).toBe(join(repo, '.cursed', 'worktrees', 'feat-x'));
      expect(r.branch).toBe('feat-x');
      expect(r.base).toMatch(/^[0-9a-f]{40}$/);
      await access(r.path);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws structured error when branch already exists', async () => {
    const repo = await freshRepo();
    try {
      await pexec('git', ['branch', 'feat-x'], { cwd: repo });
      await expect(createWorktree({ name: 'feat-x', base: 'HEAD', repoRoot: repo })).rejects.toMatchObject({
        code: 'worktree_branch_exists',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws structured error when target dir already exists', async () => {
    const repo = await freshRepo();
    try {
      await mkdir(join(repo, '.cursed', 'worktrees', 'feat-x'), { recursive: true });
      await expect(createWorktree({ name: 'feat-x', base: 'HEAD', repoRoot: repo })).rejects.toMatchObject({
        code: 'worktree_dir_exists',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws worktree_failed when base ref does not resolve', async () => {
    const repo = await freshRepo();
    try {
      await expect(createWorktree({ name: 'feat-x', base: 'bogus-ref', repoRoot: repo })).rejects.toMatchObject({
        code: 'worktree_failed',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('removes a created worktree', async () => {
    const repo = await freshRepo();
    try {
      const r = await createWorktree({ name: 'feat-y', base: 'HEAD', repoRoot: repo });
      await removeWorktree({ path: r.path, repoRoot: repo });
      await expect(access(r.path)).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects worktree names that resolve outside the worktree root', async () => {
    const repo = await freshRepo();
    try {
      await expect(createWorktree({ name: '../escape', base: 'HEAD', repoRoot: repo })).rejects.toMatchObject({
        code: 'worktree_failed',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

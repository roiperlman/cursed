import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const pexec = promisify(execFile);

/**
 * Build the MCP server with `runSolo` mocked. We reach into the module via
 * vi.mock and then construct the server fresh per test so each test gets a
 * clean mock state.
 */
/** @param {(args: Record<string, unknown>) => unknown} runSoloImpl */
async function freshServerWithMockedRun(runSoloImpl) {
  vi.resetModules();
  vi.doMock('../../scripts/lib/run.mjs', () => ({
    runSolo: vi.fn(runSoloImpl),
    runOne: vi.fn(),
  }));
  const { buildServer } = await import('../../scripts/mcp/cursed-mcp.mjs');
  return buildServer();
}

/** @param {(args: Record<string, unknown>) => unknown} runSoloImpl
 * @param {Record<string, unknown>} [configOverrides]
 */
async function freshServerWithMockedRunAndConfig(runSoloImpl, configOverrides = {}) {
  vi.resetModules();
  vi.doMock('../../scripts/lib/run.mjs', () => ({
    runSolo: vi.fn(runSoloImpl),
    runOne: vi.fn(),
  }));
  vi.doMock('../../scripts/lib/config.mjs', async () => {
    const actual = /** @type {typeof import('../../scripts/lib/config.mjs')} */ (
      await vi.importActual('../../scripts/lib/config.mjs')
    );
    return {
      ...actual,
      loadConfig: vi.fn(async () => ({
        ...actual.DEFAULT_CONFIG,
        delegate: { ...actual.DEFAULT_CONFIG.delegate, ...configOverrides },
      })),
    };
  });
  const { buildServer } = await import('../../scripts/mcp/cursed-mcp.mjs');
  return buildServer();
}

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-delwt-'));
  await pexec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await pexec('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  await pexec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await pexec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await pexec('git', ['add', 'README.md'], { cwd: dir });
  await pexec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function makeFakeRun(overrides = {}) {
  return {
    panel: false,
    command: 'delegate',
    run: {
      model: 'fake',
      tier: 'balanced',
      status: 'completed',
      session_id: 'sid',
      text: 'ok',
      files_changed: [],
      commands_run: [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      duration_ms: 1,
      transcript_path: null,
      warnings: [],
      exit_reason: 'completed',
      ...overrides,
    },
    selected_reason: 'mock',
    oc_context: null,
    worktree: null,
  };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {Record<string, unknown>} args
 */
async function callDelegate(server, args) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await client.callTool({ name: 'delegate', arguments: args });
  } finally {
    await client.close();
  }
}

describe('delegate MCP handler — dirty-tree refusal', () => {
  let origCwd = '';
  beforeEach(() => {
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  it('refuses when tree is dirty and allow_dirty unset', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      await writeFile(join(repo, 'wip.txt'), 'unstaged\n');
      const server = await freshServerWithMockedRun(async () => makeFakeRun());
      const r = await callDelegate(server, { task: 'noop' });
      expect(r.isError).toBe(true);
      const text = /** @type {{ text: string }[]} */ (r.content)[0].text;
      expect(text).toMatch(/dirty_tree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('proceeds when allow_dirty: true', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      await writeFile(join(repo, 'wip.txt'), 'unstaged\n');
      const server = await freshServerWithMockedRun(async () => makeFakeRun());
      const r = await callDelegate(server, { task: 'noop', allow_dirty: true });
      expect(r.isError).toBeFalsy();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('proceeds on a clean tree', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      const server = await freshServerWithMockedRun(async () => makeFakeRun());
      const r = await callDelegate(server, { task: 'noop' });
      expect(r.isError).toBeFalsy();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('proceeds with a warning when [delegate].dirty_tree = "warn" and tree is dirty', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      await writeFile(join(repo, 'wip.txt'), 'unstaged\n');
      const server = await freshServerWithMockedRunAndConfig(async () => makeFakeRun(), { dirty_tree: 'warn' });
      const r = await callDelegate(server, { task: 'noop' });
      expect(r.isError).toBeFalsy();
      const sc = /** @type {Record<string, any>} */ (r.structuredContent);
      expect(sc.run.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/dirty_tree/)]));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('delegate MCP handler — worktree happy path', () => {
  let origCwd = '';
  beforeEach(() => {
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  it('creates a worktree, removes on completed, branch retained', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      const server = await freshServerWithMockedRun(async (runArgs) => {
        // Assert the cwd we received looks like the worktree path.
        expect(runArgs.cwd).toMatch(/\.cursed\/worktrees\/feat-x$/);
        return makeFakeRun();
      });
      const r = await callDelegate(server, { task: 'noop', worktree: 'feat-x' });
      expect(r.isError).toBeFalsy();
      const sc = /** @type {Record<string, unknown>} */ (r.structuredContent);
      expect(sc.worktree).toMatchObject({
        branch: 'feat-x',
        cleanup_status: 'removed',
      });
      // Branch stays after cleanup.
      const { stdout: branches } = await pexec('git', ['branch'], { cwd: repo });
      expect(branches).toMatch(/feat-x/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the worktree dir when keep:true', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      const server = await freshServerWithMockedRun(async () => makeFakeRun());
      const r = await callDelegate(server, { task: 'noop', worktree: 'feat-y', keep: true });
      const sc = /** @type {Record<string, unknown>} */ (r.structuredContent);
      expect(sc.worktree).toMatchObject({ cleanup_status: 'kept-on-success' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves both worktree and branch on failed run', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      const server = await freshServerWithMockedRun(async () =>
        makeFakeRun({ status: 'failed', exit_reason: 'stall' }),
      );
      const r = await callDelegate(server, { task: 'noop', worktree: 'feat-z' });
      const sc = /** @type {Record<string, unknown>} */ (r.structuredContent);
      expect(sc.worktree).toMatchObject({ cleanup_status: 'kept-due-to-failure' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses when the requested branch already exists', async () => {
    const repo = await freshRepo();
    process.chdir(repo);
    try {
      await pexec('git', ['branch', 'feat-x'], { cwd: repo });
      const server = await freshServerWithMockedRun(async () => makeFakeRun());
      const r = await callDelegate(server, { task: 'noop', worktree: 'feat-x' });
      expect(r.isError).toBe(true);
      const text = /** @type {{ text: string }[]} */ (r.content)[0].text;
      expect(text).toMatch(/worktree_branch_exists/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

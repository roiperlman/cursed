/**
 * QA fixture for ROI-69: inline diff in SCOPE for adapters with needsInlineDiff.
 *
 * Sets up a real git repo in a temp dir with a known diff (one added file,
 * one modified file), runs the review path with antigravity-style adapter
 * mocked (no actual agy call), and asserts SCOPE contains the expected diff
 * content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const pexec = promisify(execFile);

async function git(args, cwd) {
  await pexec('git', args, { cwd });
}

/**
 * Initialize a git repo with a base commit, then create a diff:
 *  - add new file: added.ts
 *  - modify existing file: existing.ts
 * Returns the repo path and the branch expression for diffing.
 */
async function makeTestRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'cursed-qa-roi69-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@test.com'], dir);
  await git(['config', 'user.name', 'Test'], dir);

  // base commit
  await writeFile(join(dir, 'existing.ts'), 'export const x = 1;\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'init'], dir);

  // Stage changes so they appear in `git diff HEAD`
  await writeFile(join(dir, 'added.ts'), 'export const y = 2;\n');
  await writeFile(join(dir, 'existing.ts'), 'export const x = 1;\nexport const z = 3;\n');
  await git(['add', '.'], dir);

  return dir;
}

function makePanelResult() {
  return {
    panel: true,
    command: 'review',
    runs: [],
    summary: {
      models_completed: 0,
      models_failed: 0,
      total_tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      total_duration_ms: 0,
      errors: [],
    },
    transcript_aggregate_path: null,
    selected_reason: 'mock',
    oc_context: null,
  };
}

async function freshServerForRepo(runPanelMock, repoDir) {
  vi.resetModules();
  vi.doMock('../scripts/lib/panel.mjs', () => ({ runPanel: runPanelMock }));
  vi.doMock('../scripts/lib/adapters/registry.mjs', async () => {
    const actual = /** @type {any} */ (await vi.importActual('../scripts/lib/adapters/registry.mjs'));
    return {
      ...actual,
      adapterForModel: vi.fn(async () => ({
        name: 'antigravity',
        api_version: 1,
        vendors: ['google'],
        needsInlineDiff: true,
        buildArgs: () => [],
        parseStream: () => null,
        probeSetup: async () => ({}),
        defaultCatalogPath: () => '',
      })),
    };
  });

  // Use the real git.mjs but resolve the diff against our test repo by
  // patching process.cwd() — we do this by mocking resolveReviewDiff to
  // call the real implementation with the test repo's cwd.
  vi.doMock('../scripts/lib/git.mjs', async () => {
    const actual = /** @type {any} */ (await vi.importActual('../scripts/lib/git.mjs'));
    return {
      ...actual,
      gitListUntrackedFiles: vi.fn(async () => []),
      resolveReviewDiff: vi.fn(async (opts) =>
        actual.resolveReviewDiff({ ...opts, cwd: repoDir, target: 'HEAD' }),
      ),
    };
  });

  const { buildServer } = await import('../scripts/mcp/cursed-mcp.mjs');
  return buildServer();
}

describe('QA: review inline diff — fake repo fixture (ROI-69)', () => {
  /** @type {string} */
  let repoDir;

  beforeEach(async () => {
    repoDir = await makeTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('SCOPE contains --- DIFF ---, added file path, and modified file hunk header', async () => {
    const runPanel = vi.fn(async () => makePanelResult());
    const server = await freshServerForRepo(runPanel, repoDir);

    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const r = await client.callTool({ name: 'review', arguments: { target: 'HEAD' } });
      expect(r.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    const scope = call.vars.SCOPE;

    expect(scope).toContain('--- DIFF ---');
    expect(scope).toContain('added.ts');
    expect(scope).toContain('existing.ts');
    // hunk header for modified file
    expect(scope).toMatch(/@@ .* @@/);
  });
});

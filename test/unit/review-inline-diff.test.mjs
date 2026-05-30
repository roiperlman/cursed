/**
 * Unit tests for ROI-69: inline diff in SCOPE when needsInlineDiff is true.
 *
 * Tests confirm:
 *  - when any adapter in the panel has needsInlineDiff: true, vars.SCOPE
 *    contains an inlined diff block.
 *  - when all adapters have needsInlineDiff: false, SCOPE has no diff block.
 *  - git failure is surfaced in SCOPE without aborting the panel.
 *  - empty diff produces "(empty)" marker.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * @param {{ name?: string, vendor?: string, needsInlineDiff?: boolean }} [opts]
 */
function makeAdapter(opts = {}) {
  return {
    name: opts.name ?? 'claude',
    api_version: 1,
    vendors: [opts.vendor ?? 'anthropic'],
    needsInlineDiff: opts.needsInlineDiff ?? false,
    buildArgs: () => [],
    parseStream: () => null,
    probeSetup: async () => ({}),
    defaultCatalogPath: () => '',
  };
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

/**
 * @param {import('vitest').Mock} runPanelMock
 * @param {{ diffResult?: object, needsInlineDiff?: boolean }} [opts]
 */
async function freshServer(runPanelMock, opts = {}) {
  vi.resetModules();
  const diffResult = opts.diffResult ?? {
    stdout: 'diff --git a/x.ts b/x.ts\n@@ -1,1 +1,2 @@\n context\n+added\n',
    stderr: '',
    exitCode: 0,
    error: null,
  };
  const needsInlineDiff = opts.needsInlineDiff ?? true;

  vi.doMock('../../scripts/lib/panel.mjs', () => ({ runPanel: runPanelMock }));
  vi.doMock('../../scripts/lib/git.mjs', async () => {
    const actual = /** @type {any} */ (await vi.importActual('../../scripts/lib/git.mjs'));
    return {
      ...actual,
      gitListUntrackedFiles: vi.fn(async () => []),
      resolveReviewDiff: vi.fn(async () => diffResult),
    };
  });
  vi.doMock('../../scripts/lib/adapters/registry.mjs', async () => {
    const actual = /** @type {any} */ (await vi.importActual('../../scripts/lib/adapters/registry.mjs'));
    return {
      ...actual,
      adapterForModel: vi.fn(async () => makeAdapter({ name: 'antigravity', vendor: 'google', needsInlineDiff })),
    };
  });

  const { buildServer } = await import('../../scripts/mcp/cursed-mcp.mjs');
  return buildServer();
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {Record<string, unknown>} [args]
 */
async function callReview(server, args = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await client.callTool({ name: 'review', arguments: args });
  } finally {
    await client.close();
  }
}

describe('review handler — inline diff (ROI-69)', () => {
  it('inlines diff into SCOPE when needsInlineDiff: true', async () => {
    const runPanel = vi.fn(async () => makePanelResult());
    const server = await freshServer(runPanel, { needsInlineDiff: true });
    const r = await callReview(server);
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toContain('--- DIFF ---');
    expect(call.vars.SCOPE).toContain('x.ts');
    expect(call.vars.SCOPE).toContain('@@ -1,1 +1,2 @@');
  });

  it('does NOT inline diff when needsInlineDiff: false', async () => {
    const runPanel = vi.fn(async () => makePanelResult());
    const server = await freshServer(runPanel, { needsInlineDiff: false });
    const r = await callReview(server);
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toBe('diff: main...HEAD');
    expect(call.vars.SCOPE).not.toContain('--- DIFF ---');
  });

  it('shows (empty) marker when diff is empty', async () => {
    const runPanel = vi.fn(async () => makePanelResult());
    const server = await freshServer(runPanel, {
      needsInlineDiff: true,
      diffResult: { stdout: '', stderr: '', exitCode: 0, error: null },
    });
    const r = await callReview(server);
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toContain('--- DIFF ---');
    expect(call.vars.SCOPE).toContain('(empty)');
  });

  it('shows failure message in SCOPE when git diff fails, does not abort run', async () => {
    const runPanel = vi.fn(async () => makePanelResult());
    const server = await freshServer(runPanel, {
      needsInlineDiff: true,
      diffResult: { stdout: '', stderr: 'fatal: not a git repo', exitCode: 128, error: 'fatal: not a git repo' },
    });
    const r = await callReview(server);
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toContain('--- DIFF ---');
    expect(call.vars.SCOPE).toContain('diff resolution failed');
  });
});

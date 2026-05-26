import { describe, it, expect, vi } from 'vitest';
import { buildReviewScope } from '../../scripts/mcp/cursed-mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ─── Pure helper ─────────────────────────────────────────────────────────────

describe('buildReviewScope', () => {
  it('falls back to the default diff target', () => {
    expect(buildReviewScope({}, [])).toBe('diff: main...HEAD');
  });

  it('uses the supplied --target', () => {
    expect(buildReviewScope({ target: 'release/v1...HEAD' }, [])).toBe('diff: release/v1...HEAD');
  });

  it('uses path: when a path is supplied (path wins over target)', () => {
    expect(buildReviewScope({ path: 'src/foo', target: 'ignored' }, [])).toBe('path: src/foo');
  });

  it('appends untracked files when present', () => {
    const scope = buildReviewScope({}, ['LICENSE', 'new-test.spec.mjs']);
    expect(scope).toBe(
      'diff: main...HEAD\nuntracked files (include in review, per --include-untracked):\n- LICENSE\n- new-test.spec.mjs',
    );
  });

  it('does not advertise an untracked block when the list is empty', () => {
    const scope = buildReviewScope({ target: 'main...HEAD' }, []);
    expect(scope).toBe('diff: main...HEAD');
    expect(scope).not.toMatch(/untracked/);
  });

  it('appends untracked files alongside a path scope', () => {
    const scope = buildReviewScope({ path: 'src/foo' }, ['src/foo/new.ts']);
    expect(scope).toContain('path: src/foo');
    expect(scope).toContain('- src/foo/new.ts');
  });
});

// ─── MCP review handler — include_untracked integration ──────────────────────
//
// Smoke-level coverage for acceptance criterion #5: the bundle that reaches
// the panel reviewers must include untracked content when `include_untracked`
// is set. Both `runPanel` and `gitListUntrackedFiles` are mocked so the test
// runs in worker threads (no process.chdir()) while still asserting on the
// exact vars.SCOPE that gets forwarded to the reviewers.

/**
 * @param {import('vitest').Mock<any, any>} runPanelMock
 * @param {string[]} untrackedFilesMock - what gitListUntrackedFiles returns
 */
async function freshServerWithMocks(runPanelMock, untrackedFilesMock) {
  vi.resetModules();
  vi.doMock('../../scripts/lib/panel.mjs', () => ({ runPanel: runPanelMock }));
  vi.doMock('../../scripts/lib/git.mjs', async () => {
    const actual = /** @type {typeof import('../../scripts/lib/git.mjs')} */ (
      await vi.importActual('../../scripts/lib/git.mjs')
    );
    return { ...actual, gitListUntrackedFiles: vi.fn(async () => untrackedFilesMock) };
  });
  const { buildServer } = await import('../../scripts/mcp/cursed-mcp.mjs');
  return buildServer();
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
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {Record<string, unknown>} args
 */
async function callReview(server, args) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await client.callTool({ name: 'review', arguments: args });
  } finally {
    await client.close();
  }
}

describe('review MCP handler — include_untracked', () => {
  it('passes untracked file list into vars.SCOPE when include_untracked: true', async () => {
    const runPanel = /** @type {any} */ (vi.fn(async () => makePanelResult()));
    const server = await freshServerWithMocks(runPanel, ['LICENSE', 'new-test.spec.mjs']);
    const r = await callReview(server, { include_untracked: true });
    expect(r.isError).toBeFalsy();

    expect(runPanel).toHaveBeenCalledTimes(1);
    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.command).toBe('review');
    expect(call.vars.SCOPE).toContain('diff: main...HEAD');
    expect(call.vars.SCOPE).toContain('untracked files');
    expect(call.vars.SCOPE).toContain('- LICENSE');
    expect(call.vars.SCOPE).toContain('- new-test.spec.mjs');
  });

  it('omits untracked content from vars.SCOPE by default (flag off)', async () => {
    const runPanel = /** @type {any} */ (vi.fn(async () => makePanelResult()));
    // gitListUntrackedFiles should not even be called when flag is off
    const server = await freshServerWithMocks(runPanel, ['new-test.spec.mjs']);
    const r = await callReview(server, {});
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toBe('diff: main...HEAD');
    expect(call.vars.SCOPE).not.toMatch(/untracked/);
    expect(call.vars.SCOPE).not.toMatch(/new-test\.spec\.mjs/);
  });

  it('omits gitignored paths — the mock represents filtered output from --exclude-standard', async () => {
    // The gitListUntrackedFiles mock returns only the files that git would
    // return (after .gitignore filtering). We assert the SCOPE does not
    // include the ignored file to confirm the handler passes through
    // whatever the git helper returns without re-adding ignored paths.
    const runPanel = /** @type {any} */ (vi.fn(async () => makePanelResult()));
    const server = await freshServerWithMocks(runPanel, ['real-new.md']); // scratch.txt is excluded by gitignore
    const r = await callReview(server, { include_untracked: true });
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toContain('- real-new.md');
    expect(call.vars.SCOPE).not.toContain('scratch.txt');
  });

  it('produces a correct SCOPE when a --target is given alongside --include-untracked', async () => {
    const runPanel = /** @type {any} */ (vi.fn(async () => makePanelResult()));
    const server = await freshServerWithMocks(runPanel, ['docs/api.md']);
    const r = await callReview(server, { target: 'v1...HEAD', include_untracked: true });
    expect(r.isError).toBeFalsy();

    const call = /** @type {any} */ (runPanel.mock.calls[0])?.[0];
    expect(call.vars.SCOPE).toContain('diff: v1...HEAD');
    expect(call.vars.SCOPE).toContain('- docs/api.md');
  });
});

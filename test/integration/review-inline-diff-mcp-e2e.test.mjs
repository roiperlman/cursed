/**
 * Integration test for ROI-112: SCOPE inspection via direct MCP client.
 *
 * Boots the cursed MCP server as a real subprocess via StdioClientTransport,
 * with `CURSED_EMIT_SCOPE_LOG=1` set so the `review` handler publishes the
 * rendered SCOPE on the `cursed.run.scope` logger. Captures the logging
 * notification and asserts the SCOPE contains `--- DIFF ---` plus at least
 * one unified-diff hunk header.
 *
 * Why this matters: the existing `qa/review-inline-diff-fixture.test.mjs`
 * checks SCOPE via a mocked `runPanel` in-process. This test goes through a
 * real `StdioClientTransport`, so it also covers the wire path that the
 * testbed-pairing pattern described in `docs/qa-live-test-protocol.md` §6.7
 * relies on. It is the regression guardrail for ROI-69 (inline diff in
 * SCOPE) at the MCP-transport layer — see DoD bullet 3 in ROI-112.
 *
 * The test stubs `agy` with a no-op shim via `CURSED_ANTIGRAVITY_PATH` so
 * the `runPanel` call below the SCOPE-log point doesn't require the real
 * antigravity CLI. The SCOPE log fires before spawn, so the assertion is
 * deterministic regardless of how the (fake) child exits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER = resolve(REPO_ROOT, 'scripts/mcp/cursed-mcp.mjs');

async function git(args, cwd) {
  await pexec('git', args, { cwd });
}

/**
 * Initialize a git repo with a base commit, then stage a known diff:
 *   - new file `added.ts`
 *   - modified file `existing.ts`
 *
 * `git diff HEAD` against this layout yields a unified diff with both a
 * "new file" header and a hunk header for the modified file — the same
 * shape antigravity sees in real life.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeTestRepo(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.email', 'test@test'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);

  await writeFile(join(dir, 'existing.ts'), 'export const x = 1;\n');
  await git(['add', '.'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);

  await writeFile(join(dir, 'added.ts'), 'export const y = 2;\n');
  await writeFile(join(dir, 'existing.ts'), 'export const x = 1;\nexport const z = 3;\n');
  await git(['add', '.'], dir);

  return dir;
}

/**
 * Write a no-op `agy` shim in `dir` and return its absolute path. The shim
 * is wired up via `CURSED_ANTIGRAVITY_PATH` so the real `agy` CLI doesn't
 * need to be installed for this test to run. The shim exits 0 with empty
 * stdout — the run will be reported as `failed` (no stream events), which
 * is fine; we assert on the SCOPE log emitted before the spawn.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function writeFakeAgy(dir) {
  const path = join(dir, 'agy');
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

describe('integration: SCOPE inspection via direct MCP client (ROI-112)', () => {
  /** @type {string} */
  let repoDir;
  /** @type {string} */
  let toolsDir;
  /** @type {string} */
  let dataDir;
  /** @type {string} */
  let fakeAgyPath;

  beforeAll(async () => {
    repoDir = await makeTestRepo('cursed-roi112-repo-');
    toolsDir = await mkdtemp(join(tmpdir(), 'cursed-roi112-tools-'));
    fakeAgyPath = await writeFakeAgy(toolsDir);
    dataDir = await mkdtemp(join(tmpdir(), 'cursed-roi112-data-'));
    // CLAUDE_PLUGIN_DATA is read by the server for workspace/data paths.
    // Ensure the directory exists so workspace registration doesn't fail.
    await mkdir(dataDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(toolsDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('publishes rendered SCOPE on `cursed.run.scope` for antigravity --solo when CURSED_EMIT_SCOPE_LOG=1', async () => {
    /** @type {Record<string, string>} */
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    env.CURSED_EMIT_SCOPE_LOG = '1';
    env.CURSED_ANTIGRAVITY_PATH = fakeAgyPath;
    env.CLAUDE_PLUGIN_DATA = dataDir;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER],
      env,
      cwd: repoDir, // server reads process.cwd() for git operations
    });
    const client = new Client({ name: 'roi-112-test', version: '0.0.0' }, { capabilities: {} });

    /** @type {Array<{ level: string, logger?: string, data: unknown }>} */
    const scopeLogs = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notif) => {
      const params = notif.params;
      if (params?.logger === 'cursed.run.scope') {
        scopeLogs.push({ level: params.level, logger: params.logger, data: params.data });
      }
    });

    await client.connect(transport);
    try {
      // --solo via single explicit model. `antigravity-default` resolves to
      // the antigravity adapter (needsInlineDiff: true), so SCOPE will be
      // built with an `--- DIFF ---` block from `git diff HEAD`.
      const result = await client.callTool({
        name: 'review',
        arguments: { models: ['antigravity-default'], target: 'HEAD' },
      });
      // Tool itself should not be a hard error (fake agy → failed run is
      // captured in result.run, not raised as MCP error).
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    expect(scopeLogs.length).toBeGreaterThan(0);
    const log = scopeLogs[0];
    expect(log.level).toBe('info');
    expect(log.logger).toBe('cursed.run.scope');
    const data = /** @type {any} */ (log.data);
    expect(data.command).toBe('review');
    expect(data.target).toBe('HEAD');
    expect(data.needs_inline_diff).toBe(true);
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models).toContain('antigravity-default');

    const scope = /** @type {string} */ (data.scope);
    expect(typeof scope).toBe('string');
    // Regression guardrail for ROI-69 (DoD bullet 3): SCOPE must contain
    // the `--- DIFF ---` block AND the resolved diff content. Reverting
    // the inline-diff handler would drop both markers and fail here.
    expect(scope).toContain('--- DIFF ---');
    expect(scope).toContain('added.ts');
    expect(scope).toContain('existing.ts');
    // At least one unified-diff hunk header for the modified file.
    expect(scope).toMatch(/@@ .* @@/);
  }, 30_000);

  it('does NOT emit the SCOPE log when CURSED_EMIT_SCOPE_LOG is unset', async () => {
    /** @type {Record<string, string>} */
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    // Deliberately omit CURSED_EMIT_SCOPE_LOG. Strip any inherited value.
    delete env.CURSED_EMIT_SCOPE_LOG;
    env.CURSED_ANTIGRAVITY_PATH = fakeAgyPath;
    env.CLAUDE_PLUGIN_DATA = dataDir;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER],
      env,
      cwd: repoDir,
    });
    const client = new Client({ name: 'roi-112-test-off', version: '0.0.0' }, { capabilities: {} });

    /** @type {Array<unknown>} */
    const scopeLogs = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notif) => {
      if (notif.params?.logger === 'cursed.run.scope') scopeLogs.push(notif.params);
    });

    await client.connect(transport);
    try {
      await client.callTool({
        name: 'review',
        arguments: { models: ['antigravity-default'], target: 'HEAD' },
      });
    } finally {
      await client.close();
    }

    // Default-off: nothing on the scope logger.
    expect(scopeLogs.length).toBe(0);
  }, 30_000);
});

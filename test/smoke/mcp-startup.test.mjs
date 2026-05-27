import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, symlink, rm, stat, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_PATH = resolve(REPO_ROOT, 'scripts/mcp/cursed-mcp.mjs');
// The artifact the plugin actually loads (see .claude-plugin/plugin.json).
const BUNDLED_SERVER_PATH = resolve(REPO_ROOT, 'scripts/mcp/cursed-mcp.bundled.mjs');

/**
 * @template T
 * @param {(client: Client) => Promise<T>} fn
 * @param {string} [serverPath]
 * @param {Record<string, string>} [envOverride]
 * @returns {Promise<T>}
 */
async function withClient(fn, serverPath = SERVER_PATH, envOverride) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (envOverride) Object.assign(env, envOverride);
  const transport = new StdioClientTransport({ command: 'node', args: [serverPath], env });
  const client = new Client({ name: 'cursed-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe('smoke: MCP server', () => {
  it('exposes the v0.2 tool surface', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(['advise', 'config_apply', 'config_get', 'delegate', 'review', 'review_plan', 'setup']);
    });
  }, 15_000);

  it('setup returns AllAdaptersSetupResult shape', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: 'setup', arguments: {} });
      const sc = /** @type {Record<string, Record<string, unknown>>} */ (result.structuredContent ?? {});
      // Result is a map of adapter name → SetupResult.
      expect(typeof sc).toBe('object');
      for (const adapterResult of Object.values(sc)) {
        expect(typeof adapterResult.available).toBe('boolean');
        expect(typeof adapterResult.authenticated).toBe('boolean');
      }
    });
  }, 15_000);

  // NOTE: The MCP SDK's middleware handles Zod -32602 errors before they reach
  // the client throw path — it returns result.isError: true with the error text
  // in result.content[0].text instead of throwing. We assert on that shape.
  it('advise rejects empty question via Zod schema', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: 'advise', arguments: { question: '' } });
      expect(result.isError).toBe(true);
      const content = /** @type {{ text: string }[]} */ (result.content);
      expect(content[0].text).toMatch(/question|String must contain at least 1|too_small/i);
    });
  }, 15_000);

  it('delegate rejects models length > 1 via Zod schema', async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: 'delegate',
        arguments: { task: 'noop', models: ['m1', 'm2'] },
      });
      expect(result.isError).toBe(true);
      const content = /** @type {{ text: string }[]} */ (result.content);
      expect(content[0].text).toMatch(/models|too_big|at most/i);
    });
  }, 15_000);

  // Regression: Claude Code installs plugins via a symlink (e.g.
  // ~/.claude/local-marketplace/plugins/cursed → repo). The entry-point check
  // must realpath both sides; otherwise main() never runs and the spawned
  // server exits silently → "failed" plugin status.
  it('delegate schema advertises `background` and startup runs GC', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-smoke-data-'));
    try {
      await withClient(
        async (client) => {
          const tools = await client.listTools();
          const delegate = tools.tools.find((t) => t.name === 'delegate');
          expect(delegate).toBeDefined();
          const schema = /** @type {{ properties?: Record<string, unknown> }} */ (delegate?.inputSchema ?? {});
          expect(schema.properties).toBeDefined();
          expect(schema.properties).toHaveProperty('background');
          // GC now runs fire-and-forget after server.connect(). Poll for
          // last_gc.json while the server is still live; once we close the
          // client the server exits and any in-flight GC is dropped.
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            try {
              await stat(join(tmpData, 'last_gc.json'));
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
      await expect(stat(join(tmpData, 'last_gc.json'))).resolves.toBeDefined();
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 15_000);

  it('config_get returns config, path, exists, and catalog', async () => {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'config_get', arguments: {} });
      const parsed = JSON.parse(/** @type {{ text: string }[]} */ (res.content)[0].text);
      expect(parsed.config.adapters.default).toBe('cursor');
      expect(typeof parsed.path).toBe('string');
      expect(typeof parsed.exists).toBe('boolean');
      expect(Array.isArray(parsed.catalog.tiers)).toBe(true);
      expect(Array.isArray(parsed.catalog.adapters)).toBe(true);
      expect(Array.isArray(parsed.catalog.vendors)).toBe(true);
    });
  }, 15_000);

  // Regression: the bundled server (the artifact the plugin loads) resolves
  // each adapter's defaultCatalogPath() against import.meta.url, which points
  // at the bundle — not the adapter source dir — so the on-disk catalogs were
  // unreachable and every tier resolved as "unknown tier". Adapters now carry
  // an inlined `catalog`; assert the bundle surfaces non-empty tiers.
  it('bundled server resolves non-empty catalog tiers', async () => {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'config_get', arguments: {} });
      const parsed = JSON.parse(/** @type {{ text: string }[]} */ (res.content)[0].text);
      expect(Array.isArray(parsed.catalog.tiers)).toBe(true);
      expect(parsed.catalog.tiers.length).toBeGreaterThan(0);
      expect(parsed.catalog.tiers).toContain('reasoning');
    }, BUNDLED_SERVER_PATH);
  }, 15_000);

  it('boots when invoked through a symlinked install path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-symlink-'));
    try {
      const linkedRoot = join(tmp, 'plugin');
      await symlink(REPO_ROOT, linkedRoot);
      const symlinkedScript = join(linkedRoot, 'scripts/mcp/cursed-mcp.mjs');
      await withClient(async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain('setup');
      }, symlinkedScript);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  // Regression: the worker process (cursed-job.mjs) was historically guarded
  // by a naive `import.meta.url === file://${argv[1]}` check that fails under
  // the same symlinked-install path the MCP server is exposed through. A
  // silent no-op would leave jobs stuck `running` until stale TTL.
  it('worker entry-point fires through a symlinked install path', async () => {
    const { spawn } = await import('node:child_process');
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-worker-symlink-'));
    try {
      const linkedRoot = join(tmp, 'plugin');
      await symlink(REPO_ROOT, linkedRoot);
      const symlinkedWorker = join(linkedRoot, 'scripts/cursed-job.mjs');
      // No state_dir arg → expect exit 2 with the "state_dir argument required"
      // diagnostic, which proves isEntrypoint() returned true.
      const child = spawn('node', [symlinkedWorker], { stdio: ['ignore', 'pipe', 'pipe'] });
      /** @type {string[]} */
      const stderrChunks = [];
      child.stderr.on('data', (c) => stderrChunks.push(String(c)));
      const exitCode = await new Promise((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
      });
      expect(exitCode).toBe(2);
      expect(stderrChunks.join('')).toMatch(/state_dir argument required/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('smoke: config_apply', () => {
  // Each test in this describe block uses a fresh isolated CLAUDE_PLUGIN_DATA
  // directory so writes never touch the real plugin data dir.

  it('config_apply writes valid TOML and round-trips', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-config-apply-'));
    try {
      await withClient(
        async (client) => {
          const res = await client.callTool({
            name: 'config_apply',
            arguments: { config: { panel: { tier: 'fast' }, adapters: { default: 'codex' } } },
          });
          const parsed = JSON.parse(/** @type {{ text: string }[]} */ (res.content)[0].text);
          expect(parsed.ok).toBe(true);
          expect(parsed.config.panel.tier).toBe('fast');
          expect(parsed.config.adapters.default).toBe('codex');
          // re-read via config_get
          const afterRes = await client.callTool({ name: 'config_get', arguments: {} });
          const after = JSON.parse(/** @type {{ text: string }[]} */ (afterRes.content)[0].text);
          expect(after.exists).toBe(true);
          expect(after.config.panel.tier).toBe('fast');
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 20_000);

  // NOTE: the MCP SDK middleware catches thrown handler errors and returns
  // { isError: true } rather than rejecting the promise — consistent with how
  // 'advise rejects empty question via Zod schema' is tested above.
  it('config_apply warns when adapters.default is not in adapters.enabled', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-config-apply-warn-'));
    try {
      await withClient(
        async (client) => {
          const res = await client.callTool({
            name: 'config_apply',
            arguments: { config: { adapters: { default: 'gemini', enabled: ['cursor'] } } },
          });
          const parsed = JSON.parse(/** @type {{ text: string }[]} */ (res.content)[0].text);
          expect(parsed.ok).toBe(true);
          expect(Array.isArray(parsed.warnings)).toBe(true);
          const hasDefaultWarning = parsed.warnings.some(
            (/** @type {string} */ w) => w.includes('gemini') && w.toLowerCase().includes('enabled'),
          );
          expect(hasDefaultWarning).toBe(true);
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 20_000);

  it('config_apply rejects a bad partial without writing', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-config-apply-bad-'));
    try {
      await withClient(
        async (client) => {
          const res = await client.callTool({
            name: 'config_apply',
            arguments: { config: { adapters: { default: 'bogus' } } },
          });
          expect(res.isError).toBe(true);
          await expect(access(join(tmpData, 'config.toml'))).rejects.toThrow();
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 20_000);
});

// Regression / acceptance: a stale terminal background job surviving a Claude
// Code restart must be GC'd on the next startup (once its anchor is past the
// retention cutoff). We seed the data dir with a 30-day-old completed job and
// confirm the GC run deletes it and writes last_gc.json.
describe('smoke: stale-job GC on restart', () => {
  it('GC deletes a stale terminal job on server startup and writes last_gc.json', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-stale-gc-'));
    try {
      // Build a fake workspace state dir that mimics what the delegate handler writes.
      const wsId = 'test-workspace';
      const wsDir = join(tmpData, 'state', wsId);
      const jobDir = join(wsDir, 'jobs', 'stale-delegate');
      await mkdir(jobDir, { recursive: true });

      const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const meta = {
        version: 1,
        id: 'stale-delegate',
        command: 'delegate',
        tier: 'balanced',
        model: 'auto-sonnet-4-6',
        vars: { TASK: 'noop', REPO_GUIDANCE: '' },
        worktree: { path: '/tmp/nonexistent-worktree-stale', branch: 'stale-delegate', base: 'abc1234' },
        keep: false,
        started_at: longAgo,
        silence_timeout_seconds: 120,
        total_timeout_seconds: 1800,
        retention_days: 7,
      };
      await writeFile(join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      await writeFile(
        join(jobDir, 'status.json'),
        JSON.stringify({ status: 'completed', started_at: longAgo, finished_at: longAgo }, null, 2),
        'utf8',
      );

      await withClient(
        async (client) => {
          // Wait for GC to write last_gc.json (fire-and-forget, max 5s).
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            try {
              await stat(join(tmpData, 'last_gc.json'));
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
          // Verify GC ran and wrote the marker.
          await expect(stat(join(tmpData, 'last_gc.json'))).resolves.toBeDefined();
          // The stale job dir must have been deleted by GC.
          await expect(stat(jobDir)).rejects.toThrow();
          // Verify the server is still healthy after GC.
          const tools = await client.listTools();
          expect(tools.tools.map((t) => t.name)).toContain('delegate');
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 20_000);

  // Acceptance criterion: a background job whose worktree was deleted externally
  // before the next restart must not crash the server or GC. The job state
  // files are all that GC reads — missing worktrees are transparent.
  it('GC runs cleanly when a job worktree path no longer exists', async () => {
    const tmpData = await mkdtemp(join(tmpdir(), 'cursed-missing-wt-'));
    try {
      const wsDir = join(tmpData, 'state', 'ws1');
      const jobDir = join(wsDir, 'jobs', 'no-wt');
      await mkdir(jobDir, { recursive: true });

      const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const meta = {
        version: 1,
        id: 'no-wt',
        command: 'delegate',
        tier: 'balanced',
        model: 'auto-sonnet-4-6',
        vars: { TASK: 'noop', REPO_GUIDANCE: '' },
        worktree: { path: '/this/path/does/not/exist/at/all', branch: 'no-wt', base: 'abc' },
        keep: false,
        started_at: longAgo,
        silence_timeout_seconds: 120,
        total_timeout_seconds: 1800,
        retention_days: 7,
      };
      await writeFile(join(jobDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      await writeFile(
        join(jobDir, 'status.json'),
        JSON.stringify({ status: 'completed', started_at: longAgo, finished_at: longAgo }, null, 2),
        'utf8',
      );

      await withClient(
        async (client) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            try {
              await stat(join(tmpData, 'last_gc.json'));
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 50));
            }
          }
          await expect(stat(join(tmpData, 'last_gc.json'))).resolves.toBeDefined();
          // Job must have been GC'd cleanly despite missing worktree.
          await expect(stat(jobDir)).rejects.toThrow();
          // Server remains healthy.
          const tools = await client.listTools();
          expect(tools.tools.map((t) => t.name)).toContain('delegate');
        },
        SERVER_PATH,
        { CLAUDE_PLUGIN_DATA: tmpData },
      );
    } finally {
      await rm(tmpData, { recursive: true, force: true });
    }
  }, 20_000);
});

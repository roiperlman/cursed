import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SERVER_PATH = resolve(REPO_ROOT, 'scripts/mcp/cursed-mcp.mjs');

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
      expect(names).toEqual(['advise', 'config_get', 'delegate', 'plan_review', 'review', 'setup']);
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

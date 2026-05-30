import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');
const BUNDLED_MCP = join(REPO_ROOT, 'scripts/mcp/cursed-mcp.bundled.mjs');

// Boot the *bundled* MCP server as a child process, drive it as a real MCP
// client, and check that `models_list` is advertised and returns the shape
// every worker / test consumer relies on. The bundled artifact is what
// Claude Code actually ships, so this exercises both the source registration
// (scripts/mcp/cursed-mcp.mjs) and the build path (scripts/build.mjs).
describe('integration: models_list MCP tool over bundled server', () => {
  /** @type {Client} */
  let client;
  /** @type {StdioClientTransport} */
  let transport;
  /** @type {string} */
  let dataDir;

  beforeAll(async () => {
    // Point the server at a scratch data dir so it never touches the
    // developer's real cursed install. The bundled server reads
    // CLAUDE_PLUGIN_DATA via scripts/lib/state.mjs.
    dataDir = await mkdtemp(join(tmpdir(), 'cursed-mcp-models-list-'));
    // Pre-seed a minimal config so loadConfig succeeds. Default cfg shape
    // is fine — we want the merged catalog to come from the bundled adapter
    // catalogs (cursor + codex + gemini + antigravity), not user overrides.
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'config.toml'),
      `${[
        '[adapters]',
        'default = "cursor"',
        'enabled = ["cursor"]',
        '',
        '[defaults]',
        'silence_timeout_seconds = 60',
        'total_timeout_seconds = 180',
        '',
        '[panel]',
        'max_size = 3',
        'diversity = true',
        'tier = "balanced"',
        'vendors = []',
        'adapters = []',
        '',
        '[panel.commands.review]',
        'panel_size = 1',
      ].join('\n')}\n`,
    );

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLED_MCP],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDir,
      },
      stderr: 'pipe',
    });

    client = new Client({ name: 'cursed-test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // ignore — child may already be gone
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('advertises models_list in tools/list', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('models_list');
    const models_list = tools.find((t) => t.name === 'models_list');
    expect(models_list?.description).toMatch(/models reachable from this cursed install/i);
    // The plan's wire contract: vendors/adapters/tiers/format are all optional.
    const props = /** @type {Record<string, unknown>} */ (
      /** @type {{ properties?: Record<string, unknown> }} */ (models_list?.inputSchema)?.properties ?? {}
    );
    expect(Object.keys(props).sort()).toEqual(['adapters', 'format', 'tiers', 'vendors']);
  });

  it('returns markdown + structured payload for an unfiltered call', async () => {
    const res = await client.callTool({ name: 'models_list', arguments: {} });
    const data = /** @type {Record<string, unknown>} */ (res.structuredContent);
    expect(typeof data.markdown).toBe('string');
    expect(/** @type {string} */ (data.markdown)).toContain('| Slug | Adapter | Vendor | Tiers |');
    expect(Array.isArray(data.models)).toBe(true);
    expect(/** @type {unknown[]} */ (data.models).length).toBeGreaterThan(0);
    const row = /** @type {Record<string, unknown>} */ (/** @type {unknown[]} */ (data.models)[0]);
    expect(typeof row.slug).toBe('string');
    expect(typeof row.adapter).toBe('string');
    expect(typeof row.vendor).toBe('string');
    expect(Array.isArray(row.tiers)).toBe(true);
    expect(typeof data.aliases).toBe('object');
    const source = /** @type {{ enabled_adapters: string[], discovery: unknown[] }} */ (data.source);
    expect(source.enabled_adapters).toEqual(['cursor']);
    expect(Array.isArray(source.discovery)).toBe(true);
    expect(source.discovery.length).toBe(1);
  });

  it('honors the vendors filter', async () => {
    const res = await client.callTool({
      name: 'models_list',
      arguments: { vendors: ['xai'] },
    });
    const data = /** @type {{ models: Array<{ vendor: string }> }} */ (res.structuredContent);
    expect(data.models.length).toBeGreaterThan(0);
    for (const m of data.models) expect(m.vendor).toBe('xai');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** @typedef {import('../../scripts/lib/types.d.ts').Catalog} Catalog */
/** @typedef {import('../../scripts/lib/types.d.ts').Adapter} Adapter */

/**
 * @param {Pick<Catalog, "tiers" | "providers"> & { aliases?: Catalog["aliases"] }} fixture
 * @returns {Catalog}
 */
function fixtureCatalog(fixture) {
  return { version: 'test', updated_at: '2026-05-30', ...fixture };
}

/**
 * Build a registry-compatible adapter stub. Production adapters carry more
 * surface (`buildArgs`, `parseStream`, `probeSetup`) but buildModelsList only
 * touches `name`, `catalog`, `defaultCatalogPath`, and (optionally) `listModels`.
 * Provide the structural minimum and let the rest stay undefined.
 *
 * @param {Partial<Adapter> & { name: string, vendors: string[] }} spec
 * @returns {Adapter}
 */
function mockAdapter(spec) {
  return /** @type {Adapter} */ ({
    name: spec.name,
    api_version: 1,
    vendors: spec.vendors,
    defaultCatalogPath: spec.defaultCatalogPath ?? (() => '/no/such/file.json'),
    catalog: spec.catalog,
    listModels: spec.listModels,
    // Stubs for the rest of the contract; never invoked by buildModelsList.
    buildArgs: spec.buildArgs ?? (() => ({ command: '', args: [], env: {} })),
    parseStream:
      spec.parseStream ??
      (async () => ({
        session_id: null,
        text: '',
        files_changed: [],
        commands_run: [],
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        duration_ms: 0,
        errors: [],
      })),
    probeSetup:
      spec.probeSetup ??
      (async () => ({
        available: false,
        version: null,
        authenticated: false,
        default_model: null,
        providers_reachable: [],
        warnings: [],
        errors: [],
      })),
  });
}

/**
 * Minimal ConfigShape with just enough fields for `buildModelsList` to read
 * `cfg.adapters.enabled`. The rest are present so the parameter satisfies
 * the ConfigShape contract at the call site.
 *
 * @param {string[]} enabled
 * @returns {import('../../scripts/lib/types.d.ts').ConfigShape}
 */
function mockCfg(enabled) {
  return {
    defaults: { silence_timeout_seconds: 60, total_timeout_seconds: 300 },
    commands: {},
    panel: {
      max_size: 3,
      diversity: false,
      tier: 'reasoning',
      vendors: [],
      adapters: [],
      commands: {},
    },
    adapters: { default: enabled[0] ?? 'cursor', enabled },
    delegate: { dirty_tree: 'refuse', background: { retention_days: 7 } },
  };
}

/**
 * Install a `getAdapter` mock that resolves names against a fixed table.
 * The factory must also export `expandAdapterFilter` because models-list.mjs
 * statically imports it.
 *
 * @param {Record<string, Adapter>} table
 */
function mockRegistry(table) {
  vi.doMock('../../scripts/lib/adapters/registry.mjs', () => ({
    getAdapter: (/** @type {string} */ name) => {
      const a = table[name];
      if (!a) throw new Error(`mockRegistry: no adapter ${name}`);
      return a;
    },
    expandAdapterFilter: (/** @type {string[]} */ names) => {
      /** @type {Set<string>} */
      const out = new Set();
      for (const n of names) {
        const a = table[n];
        if (!a) continue;
        for (const v of a.vendors) out.add(v);
      }
      return [...out];
    },
  }));
}

describe('buildModelsList', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../scripts/lib/adapters/registry.mjs');
  });

  it('returns the full structured + markdown view when no filters are passed', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['cursor', 'openai', 'xai'],
      catalog: fixtureCatalog({
        tiers: { fast: ['composer-2'], balanced: ['gpt-mid'], reasoning: ['gpt-x', 'grok-x'] },
        providers: { cursor: ['composer-2'], openai: ['gpt-mid', 'gpt-x'], xai: ['grok-x'] },
        aliases: { grok: 'grok-x', gpt: 'gpt-x' },
      }),
    });
    const antigravity = mockAdapter({
      name: 'antigravity',
      vendors: ['google'],
      catalog: fixtureCatalog({
        tiers: { fast: ['ag-default'], balanced: ['ag-default'], reasoning: ['ag-default'] },
        providers: { google: ['ag-default'] },
        aliases: { agy: 'ag-default', antigravity: 'ag-default' },
      }),
    });
    mockRegistry({ cursor, antigravity });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor', 'antigravity']));

    expect(res._cache).toBe('miss');
    // 4 unique cursor slugs + 1 antigravity slug
    expect(res.models.map((m) => m.slug).sort()).toEqual(
      ['ag-default', 'composer-2', 'gpt-mid', 'gpt-x', 'grok-x'].sort(),
    );
    // Adapter routing: antigravity catalog claims ag-default; everything else routes via cursor.
    expect(res.models.find((m) => m.slug === 'ag-default')?.adapter).toBe('antigravity');
    expect(res.models.find((m) => m.slug === 'gpt-x')?.adapter).toBe('cursor');
    expect(res.models.find((m) => m.slug === 'grok-x')?.adapter).toBe('cursor');
    // Vendors flow through from the merged catalog's providers map.
    expect(res.models.find((m) => m.slug === 'gpt-x')?.vendor).toBe('openai');
    expect(res.models.find((m) => m.slug === 'ag-default')?.vendor).toBe('google');
    // Tier memberships preserved.
    expect(res.models.find((m) => m.slug === 'gpt-x')?.tiers).toEqual(['reasoning']);
    expect(res.models.find((m) => m.slug === 'ag-default')?.tiers).toEqual(['fast', 'balanced', 'reasoning']);
    // Markdown headers + structure.
    expect(res.markdown).toContain('| Slug | Adapter | Vendor | Tiers |');
    expect(res.markdown).toContain('|---|---|---|---|');
    expect(res.markdown).toContain('## Aliases');
    expect(res.markdown).toContain('| User says | Canonical slug | Adapter |');
    // Stable ordering: vendor → tier-priority → slug. Vendor 'cursor' sorts
    // before 'google' / 'openai' / 'xai' alphabetically; composer-2 (fast)
    // is the lone cursor-vendor row.
    const slugLines = res.markdown
      .split('\n')
      .filter(
        (l) => l.startsWith('| ') && !l.startsWith('| Slug') && !l.startsWith('| User says') && !l.startsWith('|---'),
      );
    expect(slugLines[0]).toContain('composer-2'); // cursor vendor, fast tier
    // Aliases merged across both adapters.
    expect(res.aliases).toEqual({
      grok: 'grok-x',
      gpt: 'gpt-x',
      agy: 'ag-default',
      antigravity: 'ag-default',
    });
    // Discovery: both adapters fell to inline-catalog (no listModels).
    expect(res.source.enabled_adapters).toEqual(['cursor', 'antigravity']);
    expect(res.source.discovery).toEqual([
      { adapter: 'cursor', source: 'inline-catalog', discovered_at: null },
      { adapter: 'antigravity', source: 'inline-catalog', discovered_at: null },
    ]);
  });

  it('narrows by vendor filter without affecting source.enabled_adapters', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['cursor', 'openai', 'xai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['gpt-x', 'grok-x'] },
        providers: { cursor: ['composer-2'], openai: ['gpt-x'], xai: ['grok-x'] },
      }),
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor']), { vendors: ['openai'] });

    expect(res.models.every((m) => m.vendor === 'openai')).toBe(true);
    expect(res.models.map((m) => m.slug)).toEqual(['gpt-x']);
    // Vendor filter is a post-load slice, so enabled_adapters still lists cursor.
    expect(res.source.enabled_adapters).toEqual(['cursor']);
  });

  it('narrows by adapter filter and skips non-listed adapters from discovery', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['cursor', 'openai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['gpt-x'] },
        providers: { openai: ['gpt-x'] },
        aliases: { gpt: 'gpt-x' },
      }),
    });
    const antigravity = mockAdapter({
      name: 'antigravity',
      vendors: ['google'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['ag-default'] },
        providers: { google: ['ag-default'] },
        aliases: { agy: 'ag-default' },
      }),
    });
    mockRegistry({ cursor, antigravity });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor', 'antigravity']), { adapters: ['antigravity'] });

    expect(res.source.enabled_adapters).toEqual(['antigravity']);
    expect(res.source.discovery).toEqual([{ adapter: 'antigravity', source: 'inline-catalog', discovered_at: null }]);
    expect(res.models.map((m) => m.slug)).toEqual(['ag-default']);
    expect(res.models[0].adapter).toBe('antigravity');
    // Aliases narrow too — only antigravity's aliases survive.
    expect(res.aliases).toEqual({ agy: 'ag-default' });
  });

  it('narrows by tier filter, keeping any model that overlaps at least one named tier', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['cursor', 'openai'],
      catalog: fixtureCatalog({
        tiers: { fast: ['composer-2'], balanced: ['gpt-mid'], reasoning: ['gpt-x'] },
        providers: { cursor: ['composer-2'], openai: ['gpt-mid', 'gpt-x'] },
      }),
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor']), { tiers: ['reasoning'] });

    expect(res.models.map((m) => m.slug)).toEqual(['gpt-x']);
    expect(res.models[0].tiers).toEqual(['reasoning']);
  });

  it('merges aliases across adapters with first-occurrence-wins precedence', async () => {
    const adapterA = mockAdapter({
      name: 'A',
      vendors: ['x'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['a-slug'] },
        providers: { x: ['a-slug'] },
        aliases: { shared: 'a-slug', a_only: 'a-slug' },
      }),
    });
    const adapterB = mockAdapter({
      name: 'B',
      vendors: ['y'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['b-slug'] },
        providers: { y: ['b-slug'] },
        aliases: { shared: 'b-slug', b_only: 'b-slug' },
      }),
    });
    mockRegistry({ A: adapterA, B: adapterB });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['A', 'B']));

    // A came first → A's value wins for `shared`.
    expect(res.aliases.shared).toBe('a-slug');
    expect(res.aliases.a_only).toBe('a-slug');
    expect(res.aliases.b_only).toBe('b-slug');

    // Sanity check that the precedence really comes from the input order:
    // reversing the enabled list should flip the winner.
    const reversed = await buildModelsList(mockCfg(['B', 'A']));
    expect(reversed.aliases.shared).toBe('b-slug');
  });

  it('caches results per (enabled, filter) key within the 60s TTL', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['cursor', 'openai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['gpt-x'] },
        providers: { openai: ['gpt-x'] },
      }),
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const cfg = mockCfg(['cursor']);

    const first = await buildModelsList(cfg);
    expect(first._cache).toBe('miss');

    const second = await buildModelsList(cfg);
    expect(second._cache).toBe('hit');
    // Hit must serve the same payload (sans the _cache tag).
    expect(second.models).toEqual(first.models);
    expect(second.markdown).toBe(first.markdown);
    expect(second.aliases).toEqual(first.aliases);

    // A different filter is a different cache key — back to a miss.
    const filtered = await buildModelsList(cfg, { vendors: ['openai'] });
    expect(filtered._cache).toBe('miss');
  });

  it('cache entries expire after 60s (TTL boundary)', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['openai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['gpt-x'] },
        providers: { openai: ['gpt-x'] },
      }),
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const cfg = mockCfg(['cursor']);

    let now = 1_000_000;
    const clock = { _now: () => now };
    expect((await buildModelsList(cfg, {}, clock))._cache).toBe('miss');
    now += 59_000; // still inside the 60s window
    expect((await buildModelsList(cfg, {}, clock))._cache).toBe('hit');
    now += 2_000; // now past the TTL
    expect((await buildModelsList(cfg, {}, clock))._cache).toBe('miss');
  });

  it('falls through to the inline catalog when cursor-agent discovery throws', async () => {
    // Production failure mode: cursor-agent is missing or returns non-zero.
    // `getModelSource` should still recover the inline catalog so model
    // resolution works offline; `source.discovery` must report inline-catalog
    // for the affected adapter so the caller can see the runtime probe failed.
    const listModelsMock = vi.fn().mockRejectedValue(new Error('cursor-agent: command not found'));
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['openai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['gpt-x'] },
        providers: { openai: ['gpt-x'] },
        aliases: { gpt: 'gpt-x' },
      }),
      listModels: listModelsMock,
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor']));

    expect(listModelsMock).toHaveBeenCalled();
    expect(res.models.map((m) => m.slug)).toEqual(['gpt-x']);
    expect(res.aliases.gpt).toBe('gpt-x');
    expect(res.source.discovery).toEqual([{ adapter: 'cursor', source: 'inline-catalog', discovered_at: null }]);
  });

  it('marks discovery as runtime and stamps a timestamp when listModels returns models', async () => {
    const cursor = mockAdapter({
      name: 'cursor',
      vendors: ['openai'],
      catalog: fixtureCatalog({
        tiers: { reasoning: ['from-catalog'] },
        providers: { openai: ['from-catalog'] },
      }),
      listModels: async () => [{ slug: 'from-runtime', vendor: 'openai', tier: 'reasoning' }],
    });
    mockRegistry({ cursor });

    const { buildModelsList } = await import('../../scripts/lib/models-list.mjs');
    const res = await buildModelsList(mockCfg(['cursor']));

    // listModels won → runtime-discovered slug supersedes the inline catalog.
    expect(res.models.map((m) => m.slug)).toEqual(['from-runtime']);
    expect(res.source.discovery[0].source).toBe('runtime');
    expect(res.source.discovery[0].discovered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

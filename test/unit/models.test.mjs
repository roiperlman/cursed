import { describe, it, expect } from 'vitest';
import {
  resolveModels,
  loadCatalog,
  getModelSource,
  loadMergedCatalog,
  validateExplicitModels,
} from '../../scripts/lib/models.mjs';
import { expandAdapterFilter } from '../../scripts/lib/adapters/registry.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** @typedef {import("../../scripts/lib/types.d.ts").Catalog} Catalog */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG = resolve(__dirname, '..', '..', 'models.default.json');

/**
 * @param {Pick<Catalog, "tiers" | "providers">} fixture
 * @returns {Catalog}
 */
function fixtureCatalog(fixture) {
  return { version: 'test', updated_at: '2026-04-28', ...fixture };
}

describe('models', () => {
  it('loadCatalog reads models.default.json', async () => {
    const cat = await loadCatalog(CATALOG);
    expect(Array.isArray(cat.tiers.balanced)).toBe(true);
    expect(cat.tiers.balanced.length).toBeGreaterThan(0);
  });

  it('resolveModels picks the first model in the tier for solo runs', async () => {
    const cat = await loadCatalog(CATALOG);
    const models = resolveModels(cat, { tier: 'reasoning', count: 1 });
    expect(models).toEqual([cat.tiers.reasoning[0]]);
  });

  it('resolveModels with explicit list passes through', async () => {
    const cat = await loadCatalog(CATALOG);
    const models = resolveModels(cat, { explicit: ['foo', 'bar'] });
    expect(models).toEqual(['foo', 'bar']);
  });

  it('resolveModels throws on unknown tier', async () => {
    const cat = await loadCatalog(CATALOG);
    expect(() => resolveModels(cat, { tier: 'mystery', count: 1 })).toThrow(/unknown tier/);
  });

  it('resolveModels clamps count to tier length', async () => {
    const cat = await loadCatalog(CATALOG);
    const models = resolveModels(cat, { tier: 'balanced', count: 99 });
    expect(models.length).toBe(cat.tiers.balanced.length);
  });

  it('resolveModels with diversity picks one model per provider, in tier order', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['claude-x', 'gpt-x', 'grok-x', 'gemini-x'] },
      providers: {
        anthropic: ['claude-x'],
        openai: ['gpt-x'],
        xai: ['grok-x'],
        google: ['gemini-x'],
      },
    });
    const models = resolveModels(cat, { tier: 'reasoning', count: 3, diversity: true });
    expect(models).toEqual(['claude-x', 'gpt-x', 'grok-x']);
  });

  it('resolveModels with diversity tops up from tier order when providers exhausted', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['claude-x', 'claude-y', 'gpt-x'] },
      providers: {
        anthropic: ['claude-x', 'claude-y'],
        openai: ['gpt-x'],
      },
    });
    const models = resolveModels(cat, { tier: 'reasoning', count: 3, diversity: true });
    // first per-provider pass → ['claude-x', 'gpt-x']; top-up appends
    // remaining tier members in order → 'claude-y'
    expect(models).toEqual(['claude-x', 'gpt-x', 'claude-y']);
  });

  it('resolveModels with diversity returns shorter list when tier smaller than count', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['claude-x', 'gpt-x'] },
      providers: { anthropic: ['claude-x'], openai: ['gpt-x'] },
    });
    const models = resolveModels(cat, { tier: 'reasoning', count: 3, diversity: true });
    expect(models).toEqual(['claude-x', 'gpt-x']);
  });

  it('resolveModels with count: 1 ignores diversity flag (always tier[0])', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['claude-x', 'gpt-x'] },
      providers: { anthropic: ['claude-x'], openai: ['gpt-x'] },
    });
    const models = resolveModels(cat, { tier: 'reasoning', count: 1, diversity: true });
    expect(models).toEqual(['claude-x']);
  });

  it('resolveModels with explicit list ignores diversity', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['claude-x', 'gpt-x'] },
      providers: { anthropic: ['claude-x'], openai: ['gpt-x'] },
    });
    const models = resolveModels(cat, { tier: 'reasoning', count: 3, diversity: true, explicit: ['custom-x'] });
    expect(models).toEqual(['custom-x']);
  });

  describe('resolveModels vendor filter', () => {
    const cat = fixtureCatalog({
      tiers: { reasoning: ['gpt-x', 'grok-y', 'gem-z'] },
      providers: { openai: ['gpt-x'], xai: ['grok-y'], google: ['gem-z'] },
    });

    it('keeps only models whose vendor is in the allowlist', () => {
      expect(resolveModels(cat, { tier: 'reasoning', count: 3, vendors: ['openai', 'google'] })).toEqual([
        'gpt-x',
        'gem-z',
      ]);
    });

    it('empty vendors array means no filter', () => {
      expect(resolveModels(cat, { tier: 'reasoning', count: 3, vendors: [] })).toEqual(['gpt-x', 'grok-y', 'gem-z']);
    });

    it('throws a clear error when the filter empties the tier', () => {
      expect(() => resolveModels(cat, { tier: 'reasoning', count: 3, vendors: ['moonshot'] })).toThrow(
        /no models match tier "reasoning" with the configured/,
      );
    });
  });
});

describe('getModelSource', () => {
  it('returns {tiers,providers} from listModels when present', async () => {
    const fake = {
      name: 'fake',
      vendors: ['openai'],
      defaultCatalogPath: () => '/nonexistent.json',
      listModels: async () => [
        { slug: 'm1', vendor: 'openai', tier: 'fast' },
        { slug: 'm2', vendor: 'openai', tier: 'reasoning' },
      ],
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers.fast).toEqual(['m1']);
    expect(src.tiers.reasoning).toEqual(['m2']);
    expect(src.providers.openai).toEqual(expect.arrayContaining(['m1', 'm2']));
  });

  it('falls back to the static catalog when listModels is absent', async () => {
    const fake = {
      name: 'fake',
      vendors: ['google'],
      defaultCatalogPath: () => CATALOG, // cursor models.default.json
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(Array.isArray(src.tiers.reasoning)).toBe(true);
  });

  it('returns empty source for a missing catalog file', async () => {
    const fake = { name: 'fake', vendors: ['openai'], defaultCatalogPath: () => '/no/such/file.json' };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers).toEqual({});
    expect(src.providers).toEqual({});
  });

  it('uses the inlined `catalog` field and never touches defaultCatalogPath', async () => {
    let pathCalled = false;
    const fake = {
      name: 'fake',
      vendors: ['google'],
      // Bogus path: if getModelSource read it, the source would come back empty.
      defaultCatalogPath: () => {
        pathCalled = true;
        return '/no/such/file.json';
      },
      catalog: fixtureCatalog({
        tiers: { reasoning: ['inline-x'] },
        providers: { google: ['inline-x'] },
      }),
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers.reasoning).toEqual(['inline-x']);
    expect(src.providers.google).toEqual(['inline-x']);
    expect(pathCalled).toBe(false);
  });

  it('listModels takes precedence over an inlined catalog', async () => {
    const fake = {
      name: 'fake',
      vendors: ['openai'],
      defaultCatalogPath: () => '/no/such/file.json',
      catalog: fixtureCatalog({ tiers: { reasoning: ['from-catalog'] }, providers: {} }),
      listModels: async () => [{ slug: 'from-listmodels', vendor: 'openai', tier: 'reasoning' }],
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers.reasoning).toEqual(['from-listmodels']);
  });

  it('falls back to the inlined catalog when listModels returns []', async () => {
    const fake = {
      name: 'fake',
      vendors: ['openai'],
      defaultCatalogPath: () => '/no/such/file.json',
      catalog: fixtureCatalog({
        tiers: { reasoning: ['from-catalog'] },
        providers: { openai: ['from-catalog'] },
      }),
      listModels: async () => [],
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers.reasoning).toEqual(['from-catalog']);
    expect(src.providers.openai).toEqual(['from-catalog']);
  });

  it('falls back to the inlined catalog when listModels throws', async () => {
    const fake = {
      name: 'fake',
      vendors: ['openai'],
      defaultCatalogPath: () => '/no/such/file.json',
      catalog: fixtureCatalog({
        tiers: { reasoning: ['from-catalog'] },
        providers: { openai: ['from-catalog'] },
      }),
      listModels: async () => {
        throw new Error('cursor-agent unavailable');
      },
    };
    const src = await getModelSource(/** @type {any} */ (fake));
    expect(src.tiers.reasoning).toEqual(['from-catalog']);
    expect(src.providers.openai).toEqual(['from-catalog']);
  });
});

describe('registered adapters expose an inlined catalog', () => {
  // Regression guard for the bundled-server bug: cursor/gemini/antigravity
  // resolve defaultCatalogPath() against import.meta.url, which no longer
  // points at the adapter source dir once bundled. The inlined `catalog`
  // field must carry the tier data so model resolution survives bundling.
  it.each(['cursor', 'gemini', 'antigravity'])('%s ships a catalog with non-empty tiers', async (name) => {
    const { getAdapter } = await import('../../scripts/lib/adapters/registry.mjs');
    const adapter = getAdapter(name);
    expect(adapter.catalog).toBeDefined();
    const src = await getModelSource(adapter);
    expect(Object.keys(src.tiers).length).toBeGreaterThan(0);
  });
});

describe('loadMergedCatalog', () => {
  it('unions tiers and providers across enabled adapters', async () => {
    const merged = await loadMergedCatalog(['cursor', 'gemini']);
    // gemini ships gemini-3.1-pro-preview in reasoning; cursor ships gpt-* in reasoning
    expect(merged.tiers.reasoning.length).toBeGreaterThan(0);
    // Slug must exist in scripts/lib/adapters/gemini/catalog.json — update this
    // assertion if that catalog changes.
    expect(merged.providers.google).toEqual(expect.arrayContaining(['gemini-3.1-pro-preview']));
  });
});

describe('expandAdapterFilter', () => {
  it('expands adapter names to the union of their vendors', () => {
    expect(expandAdapterFilter(['gemini'])).toEqual(['google']);
    expect(expandAdapterFilter([])).toEqual([]);
  });
});

describe('validateExplicitModels (ROI-110)', () => {
  // Background: the cursed-worker subagent forwards `--models <id>` verbatim
  // to the MCP tool. When the id is unknown, the layer must throw a structured
  // error rather than letting it fall through to the cursor fallback (which
  // surfaces an opaque CLI error and let the subagent hallucinate around it).
  it('returns without throwing when explicit is undefined', () => {
    const cat = fixtureCatalog({ tiers: {}, providers: { openai: ['gpt-x'] } });
    expect(() => validateExplicitModels(cat, undefined)).not.toThrow();
  });

  it('returns without throwing when explicit is empty', () => {
    const cat = fixtureCatalog({ tiers: {}, providers: { openai: ['gpt-x'] } });
    expect(() => validateExplicitModels(cat, [])).not.toThrow();
  });

  it('accepts a known model declared by some provider', () => {
    const cat = fixtureCatalog({
      tiers: {},
      providers: { openai: ['gpt-5.4-mini-medium'], anthropic: ['claude-4.5-sonnet'] },
    });
    expect(() => validateExplicitModels(cat, ['gpt-5.4-mini-medium'])).not.toThrow();
    expect(() => validateExplicitModels(cat, ['claude-4.5-sonnet'])).not.toThrow();
  });

  it('throws a structured validation_error for an unknown model id', () => {
    const cat = fixtureCatalog({
      tiers: {},
      providers: { openai: ['gpt-5.4-mini-medium'] },
    });
    expect(() => validateExplicitModels(cat, ['gpt-5.4-mini'])).toThrow(
      /validation_error: unknown model "gpt-5.4-mini"/,
    );
  });

  it('lists every unknown model when multiple are bogus', () => {
    const cat = fixtureCatalog({
      tiers: {},
      providers: { openai: ['gpt-x'] },
    });
    expect(() => validateExplicitModels(cat, ['bogus-1', 'bogus-2'])).toThrow(
      /validation_error: unknown models "bogus-1", "bogus-2"/,
    );
  });

  it('rejects when even one of several explicit models is unknown', () => {
    const cat = fixtureCatalog({
      tiers: {},
      providers: { openai: ['gpt-x'] },
    });
    expect(() => validateExplicitModels(cat, ['gpt-x', 'bogus'])).toThrow(/validation_error: unknown model "bogus"/);
  });

  it('tolerates a catalog without providers (treats every id as unknown)', () => {
    const cat = fixtureCatalog({ tiers: {}, providers: {} });
    expect(() => validateExplicitModels(cat, ['any-id'])).toThrow(/validation_error/);
  });
});

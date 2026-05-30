import { describe, it, expect, vi } from 'vitest';

/**
 * Fake adapter registry used to exercise `loadMergedCatalog`'s alias merge
 * precedence (first-occurrence wins, matching the existing tiers/providers
 * merge). Done as a module-scoped `vi.mock` so we never touch the real
 * adapter registry's frozen object.
 *
 * @typedef {import('../../scripts/lib/types.d.ts').Adapter} Adapter
 * @typedef {import('../../scripts/lib/types.d.ts').Catalog} Catalog
 */

/** @type {Record<string, Partial<Adapter>>} */
const fakeAdapters = {
  alpha: {
    name: 'alpha',
    vendors: ['vx'],
    defaultCatalogPath: () => '/no/such/file.json',
    catalog: /** @type {Catalog} */ ({
      version: 't',
      updated_at: '2026-05-30',
      tiers: { reasoning: ['alpha-1'] },
      providers: { vx: ['alpha-1'] },
      aliases: { shared: 'alpha-1', only_alpha: 'alpha-1' },
    }),
  },
  beta: {
    name: 'beta',
    vendors: ['vy'],
    defaultCatalogPath: () => '/no/such/file.json',
    catalog: /** @type {Catalog} */ ({
      version: 't',
      updated_at: '2026-05-30',
      tiers: { reasoning: ['beta-1'] },
      providers: { vy: ['beta-1'] },
      aliases: { shared: 'beta-1', only_beta: 'beta-1' },
    }),
  },
  silent: {
    name: 'silent',
    vendors: ['vz'],
    defaultCatalogPath: () => '/no/such/file.json',
    catalog: /** @type {Catalog} */ ({
      version: 't',
      updated_at: '2026-05-30',
      tiers: {},
      providers: {},
      // no aliases at all
    }),
  },
};

vi.mock('../../scripts/lib/adapters/registry.mjs', () => ({
  getAdapter: (/** @type {string} */ name) => {
    const a = fakeAdapters[name];
    if (!a) throw new Error(`unknown adapter: ${name}`);
    return a;
  },
}));

const { loadMergedCatalog } = await import('../../scripts/lib/models.mjs');

describe('loadMergedCatalog alias merge precedence', () => {
  it('first-declared adapter wins on overlapping aliases', async () => {
    const merged = await loadMergedCatalog(['alpha', 'beta']);
    expect(merged.aliases).toEqual({
      shared: 'alpha-1',
      only_alpha: 'alpha-1',
      only_beta: 'beta-1',
    });
  });

  it('reversing adapter order reverses which alias wins', async () => {
    const merged = await loadMergedCatalog(['beta', 'alpha']);
    expect(merged.aliases?.shared).toBe('beta-1');
  });

  it('skips adapters without aliases without losing other adapters', async () => {
    const merged = await loadMergedCatalog(['silent', 'alpha']);
    expect(merged.aliases).toEqual({
      shared: 'alpha-1',
      only_alpha: 'alpha-1',
    });
  });
});

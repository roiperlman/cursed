import { describe, it, expect } from 'vitest';
import { resolveModels, loadCatalog } from '../../scripts/lib/models.mjs';
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

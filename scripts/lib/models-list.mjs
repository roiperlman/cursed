import { readFile as fsReadFile } from 'node:fs/promises';
import { getAdapter, expandAdapterFilter } from './adapters/registry.mjs';
import { loadMergedCatalog } from './models.mjs';

/** @typedef {import('./types.d.ts').Catalog} Catalog */
/** @typedef {import('./types.d.ts').ConfigShape} ConfigShape */
/** @typedef {import('./types.d.ts').Adapter} Adapter */

/**
 * One enabled-adapter line of provenance returned in `source.discovery`.
 *
 * @typedef {object} DiscoveryEntry
 * @property {string} adapter           - Adapter name (matches `Adapter.name`).
 * @property {'runtime'|'inline-catalog'|'on-disk'|'unavailable'} source
 * @property {string|null} discovered_at - ISO timestamp when `source === 'runtime'`; null otherwise.
 */

/**
 * One row in the structured `models[]` view.
 *
 * @typedef {object} ModelRow
 * @property {string} slug      - Canonical model id.
 * @property {string} adapter   - Routing adapter (per `adapterForModel` precedence).
 * @property {string} vendor    - Declared vendor namespace (first occurrence in providers map).
 * @property {string[]} tiers   - Tier memberships from the merged catalog.
 */

/**
 * Cached wire shape returned by `buildModelsList` (without the per-call `_cache` tag).
 *
 * @typedef {object} ModelsListResult
 * @property {string} markdown
 * @property {ModelRow[]} models
 * @property {Record<string,string>} aliases
 * @property {{ enabled_adapters: string[], discovery: DiscoveryEntry[] }} source
 */

/**
 * Filter options accepted by `buildModelsList`. All optional; missing/empty
 * fields disable that dimension's filter.
 *
 * @typedef {object} BuildModelsListOptions
 * @property {string[]} [vendors]   - Vendor allowlist; drop models whose vendor isn't listed.
 * @property {string[]} [adapters]  - Routing-adapter allowlist; narrows `cfg.adapters.enabled`.
 * @property {string[]} [tiers]     - Tier allowlist; keep models with at least one matching tier.
 */

/**
 * Internal injection hooks. Production callers leave these unset; tests use
 * them to mock the registry/filesystem without `vi.doMock`.
 *
 * @typedef {object} BuildModelsListInternals
 * @property {(name: string) => Adapter} [_getAdapter]
 * @property {(path: string, encoding: string) => Promise<string>} [_readFile]
 * @property {() => number} [_now]
 */

const TTL_MS = 60_000;

/**
 * Process-level cache. Keyed by the sorted enabled-adapter set + filter
 * fingerprint. Stored entries never carry `_cache`; the field is applied at
 * the call boundary so a cache hit and a cache miss can share one entry.
 *
 * @type {Map<string, { result: ModelsListResult, expiresAt: number }>}
 */
const _CACHE = new Map();

/**
 * Reset the process-level cache. Test-only: production callers rely on TTL.
 */
export function _resetCache() {
  _CACHE.clear();
}

/**
 * Adapter precedence used when resolving a slug → routing adapter without
 * doing one filesystem probe per slug. Mirrors `adapterForModel`: codex,
 * gemini, then antigravity are checked in order; anything not listed in any
 * of those catalogs defaults to cursor.
 *
 * @type {readonly string[]}
 */
const ADAPTER_LOOKUP_ORDER = Object.freeze(['codex', 'gemini', 'antigravity']);

/**
 * Tier sort priority used by the markdown view. The canonical tiers come
 * first in their conventional fast → balanced → reasoning order; any
 * adapter-declared custom tier sorts after them in stable input order.
 *
 * @type {Readonly<Record<string, number>>}
 */
const TIER_PRIORITY = Object.freeze({ fast: 0, balanced: 1, reasoning: 2 });

/**
 * Build a stable cache key from the (narrowed) enabled-adapter list and the
 * filter options. The enabled list is NOT sorted because adapter order is
 * load-bearing — `loadMergedCatalog` merges aliases first-occurrence-wins,
 * so swapping the order can flip the winning alias value. Vendor and tier
 * filter lists ARE sorted because they're allowlists with no ordering effect.
 *
 * @param {string[]} enabled
 * @param {BuildModelsListOptions} opts
 * @returns {string}
 */
function makeCacheKey(enabled, opts) {
  const fingerprint = {
    vendors: opts.vendors ? [...opts.vendors].sort() : null,
    tiers: opts.tiers ? [...opts.tiers].sort() : null,
  };
  // `adapters` is already baked into `enabled` (it narrows cfg.adapters.enabled
  // before we hit the cache), so we don't include it again in the fingerprint.
  return `${JSON.stringify(enabled)}|${JSON.stringify(fingerprint)}`;
}

/**
 * Intersect `cfg.adapters.enabled` with an optional adapter allowlist.
 * Order from cfg.adapters.enabled is preserved so the caller can rely on
 * load-order (cursor first when both are enabled, etc.).
 *
 * @param {string[]} enabled
 * @param {string[] | undefined} filter
 * @returns {string[]}
 */
function narrowEnabled(enabled, filter) {
  if (!filter || filter.length === 0) return [...enabled];
  const allow = new Set(filter);
  return enabled.filter((n) => allow.has(n));
}

/**
 * Probe one adapter for its model source. Mirrors `getModelSource` precedence
 * but returns the source label alongside the data so `source.discovery` is a
 * by-product of the same probe — saves a second `listModels()` shell-out.
 *
 * Tolerates a missing/malformed catalog the same way `getModelSource` does:
 * an inline catalog wins over a missing on-disk file, and a missing on-disk
 * file falls through to `'unavailable'`.
 *
 * @param {Adapter} adapter
 * @param {(path: string, encoding: string) => Promise<string>} readFile
 * @returns {Promise<DiscoveryEntry>}
 */
async function probeDiscovery(adapter, readFile) {
  if (typeof adapter.listModels === 'function') {
    try {
      const models = await adapter.listModels();
      if (models.length > 0) {
        return { adapter: adapter.name, source: 'runtime', discovered_at: new Date().toISOString() };
      }
    } catch {
      // fall through
    }
  }
  if (adapter.catalog) {
    return { adapter: adapter.name, source: 'inline-catalog', discovered_at: null };
  }
  try {
    await readFile(adapter.defaultCatalogPath(), 'utf8');
    return { adapter: adapter.name, source: 'on-disk', discovered_at: null };
  } catch {
    return { adapter: adapter.name, source: 'unavailable', discovered_at: null };
  }
}

/**
 * Build a slug → adapter routing map for the enabled adapters. Walks codex,
 * gemini, then antigravity catalogs once each (instead of probing per slug
 * the way `adapterForModel` does), then defaults everything else to cursor
 * when cursor is enabled. Slugs unique to a non-enabled adapter simply don't
 * appear in the merged catalog, so they never get queried here.
 *
 * @param {string[]} enabled
 * @param {(name: string) => Adapter} resolveAdapter
 * @param {(path: string, encoding: string) => Promise<string>} readFile
 * @returns {Promise<Map<string, string>>}
 */
async function buildAdapterMap(enabled, resolveAdapter, readFile) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const name of ADAPTER_LOOKUP_ORDER) {
    if (!enabled.includes(name)) continue;
    const a = resolveAdapter(name);
    /** @type {string[]} */
    let slugs = [];
    if (a.catalog) {
      slugs = Object.values(a.catalog.providers ?? {}).flat();
    } else {
      try {
        const raw = await readFile(a.defaultCatalogPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.models)) {
          slugs = parsed.models.map((/** @type {{ slug: string }} */ m) => m.slug);
        } else {
          slugs = Object.values(parsed.providers ?? {}).flat();
        }
      } catch {
        slugs = [];
      }
    }
    for (const slug of slugs) {
      if (!map.has(slug)) map.set(slug, name);
    }
  }
  return map;
}

/**
 * Pick the lowest TIER_PRIORITY value across a model's tier memberships.
 * Used as the secondary sort key in the markdown view. Models with no tier
 * — possible when an adapter declares providers without tier curation —
 * sort after every tiered model.
 *
 * @param {string[]} tiers
 * @returns {number}
 */
function tierSortKey(tiers) {
  if (tiers.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const t of tiers) {
    const p = TIER_PRIORITY[t];
    const v = p === undefined ? 99 : p;
    if (v < best) best = v;
  }
  return best;
}

/**
 * Render the markdown view. Stable ordering: vendor → tier-priority → slug.
 * The `## Aliases` section groups shorthands by their canonical slug so
 * `agy` and `antigravity` share one row.
 *
 * @param {ModelRow[]} models  - Already filtered; rendered as-is post-sort.
 * @param {Record<string,string>} aliases
 * @param {Map<string,string>} adapterOf
 * @returns {string}
 */
function renderMarkdown(models, aliases, adapterOf) {
  const sorted = [...models].sort((a, b) => {
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    const ta = tierSortKey(a.tiers);
    const tb = tierSortKey(b.tiers);
    if (ta !== tb) return ta - tb;
    return a.slug.localeCompare(b.slug);
  });

  const lines = ['| Slug | Adapter | Vendor | Tiers |', '|---|---|---|---|'];
  for (const m of sorted) {
    lines.push(`| ${m.slug} | ${m.adapter} | ${m.vendor} | ${m.tiers.join(', ')} |`);
  }

  // Group shorthands by canonical slug so the table reads "agy, antigravity → antigravity-default".
  /** @type {Map<string, string[]>} */
  const canonicalToAliases = new Map();
  for (const [shorthand, canonical] of Object.entries(aliases)) {
    const existing = canonicalToAliases.get(canonical);
    if (existing) existing.push(shorthand);
    else canonicalToAliases.set(canonical, [shorthand]);
  }

  lines.push('', '## Aliases', '| User says | Canonical slug | Adapter |', '|---|---|---|');
  const canonicals = [...canonicalToAliases.keys()].sort();
  for (const canonical of canonicals) {
    const shorthands = canonicalToAliases.get(canonical) ?? [];
    shorthands.sort();
    const adapter = adapterOf.get(canonical) ?? 'cursor';
    lines.push(`| ${shorthands.join(', ')} | ${canonical} | ${adapter} |`);
  }
  return lines.join('\n');
}

/**
 * Build the structured + markdown view of the models reachable from this
 * cursed install. Output shape:
 *
 *   `{ markdown, models[], aliases, source, _cache: 'hit' | 'miss' }`
 *
 * Filters narrow the model list (all optional):
 *   - `opts.adapters` intersects `cfg.adapters.enabled` BEFORE the merged
 *     catalog is loaded — passing only `['codex']` skips the cursor/gemini
 *     catalog reads entirely.
 *   - `opts.vendors` keeps models whose declared vendor is in the allowlist.
 *   - `opts.tiers` keeps models with at least one matching tier membership.
 *
 * Caching: a process-level Map keyed on sorted enabled adapters + filter
 * fingerprint, TTL 60s. A cache hit short-circuits the merged-catalog load
 * AND the discovery probes (cursor-agent shells out, so back-to-back calls
 * benefit). `_cache: 'hit' | 'miss'` lets tests assert the cache behavior.
 *
 * Pure library: no MCP-side state, no on-disk writes.
 *
 * @param {ConfigShape} cfg
 * @param {BuildModelsListOptions} [opts]
 * @param {BuildModelsListInternals} [internals]
 * @returns {Promise<ModelsListResult & { _cache: 'hit' | 'miss' }>}
 */
export async function buildModelsList(cfg, opts = {}, internals = {}) {
  const resolveAdapter = internals._getAdapter ?? getAdapter;
  const readFile = internals._readFile ?? /** @type {any} */ (fsReadFile);
  const now = (internals._now ?? Date.now)();

  const enabled = narrowEnabled(cfg.adapters.enabled, opts.adapters);
  const key = makeCacheKey(enabled, opts);

  const hit = _CACHE.get(key);
  if (hit && hit.expiresAt > now) {
    return { ...hit.result, _cache: 'hit' };
  }

  // Load the merged catalog (alias-aware as of ROI-105) and probe each enabled
  // adapter's discovery source in parallel. The double-probe of `listModels`
  // — once via loadMergedCatalog → getModelSource, once via probeDiscovery —
  // is acceptable: the cache absorbs back-to-back calls inside the 60s window,
  // and `cursor-agent models` is the only adapter that pays a real cost.
  const [merged, discovery] = await Promise.all([
    loadMergedCatalog(enabled),
    Promise.all(enabled.map((name) => probeDiscovery(resolveAdapter(name), readFile))),
  ]);

  // providerOf: slug → first-declared vendor (matches resolveModels semantics).
  /** @type {Map<string, string>} */
  const providerOf = new Map();
  for (const [vendor, slugs] of Object.entries(merged.providers ?? {})) {
    for (const s of slugs) if (!providerOf.has(s)) providerOf.set(s, vendor);
  }

  // tiersOf: slug → list of tier memberships, in catalog order.
  /** @type {Map<string, string[]>} */
  const tiersOf = new Map();
  for (const [tier, slugs] of Object.entries(merged.tiers ?? {})) {
    for (const s of slugs) {
      const arr = tiersOf.get(s);
      if (arr) {
        if (!arr.includes(tier)) arr.push(tier);
      } else {
        tiersOf.set(s, [tier]);
      }
    }
  }

  const adapterOf = await buildAdapterMap(enabled, resolveAdapter, readFile);
  const cursorEnabled = enabled.includes('cursor');

  /** @type {Set<string>} */
  const vendorFilter = opts.vendors && opts.vendors.length > 0 ? new Set(opts.vendors) : new Set();
  /** @type {Set<string>} */
  const tierFilter = opts.tiers && opts.tiers.length > 0 ? new Set(opts.tiers) : new Set();

  /** @type {ModelRow[]} */
  const models = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const slugs of Object.values(merged.providers ?? {})) {
    for (const slug of slugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      const vendor = providerOf.get(slug) ?? '';
      const tiers = tiersOf.get(slug) ?? [];
      const adapter = adapterOf.get(slug) ?? (cursorEnabled ? 'cursor' : (enabled[0] ?? 'cursor'));
      if (vendorFilter.size > 0 && !vendorFilter.has(vendor)) continue;
      if (tierFilter.size > 0 && !tiers.some((t) => tierFilter.has(t))) continue;
      models.push({ slug, adapter, vendor, tiers });
    }
  }

  const aliases = merged.aliases ?? {};
  const markdown = renderMarkdown(models, aliases, adapterOf);

  /** @type {ModelsListResult} */
  const result = {
    markdown,
    models,
    aliases,
    source: {
      enabled_adapters: enabled,
      discovery,
    },
  };

  _CACHE.set(key, { result, expiresAt: now + TTL_MS });
  return { ...result, _cache: 'miss' };
}

/**
 * Expand a list of adapter names to the union of their vendors. Re-export
 * the registry helper so MCP-tool callers can resolve a `vendors: []`
 * fingerprint without importing two paths.
 *
 * @param {string[]} adapterNames
 * @returns {string[]}
 */
export { expandAdapterFilter };

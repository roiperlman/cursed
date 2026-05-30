import { readFile } from 'node:fs/promises';
import { getAdapter } from './adapters/registry.mjs';

/** @typedef {import("./types.d.ts").Catalog} Catalog */

/**
 * Load a model catalog from a JSON file on disk.
 *
 * @param {string} path
 * @returns {Promise<Catalog>}
 */
export async function loadCatalog(path) {
  const raw = await readFile(path, 'utf8');
  return /** @type {Catalog} */ (JSON.parse(raw));
}

/**
 * @typedef {object} ResolveModelsOptions
 * @property {string} [tier] - Tier name; must exist in `catalog.tiers`. Required unless `explicit` is non-empty.
 * @property {number} [count] - Desired number of models. Defaults to 1.
 * @property {boolean} [diversity] - When true and count > 1, pick at most one model per provider.
 * @property {string[]} [explicit] - When non-empty, return verbatim and bypass tier/diversity logic.
 * @property {string[]} [vendors] - Vendor allowlist. When non-empty, drop tier members whose provider is not listed.
 */

/**
 * Resolve a list of model IDs from a catalog.
 *
 * Returns array of model IDs (length ≤ count). May be < count if the tier
 * is smaller than count; never empty unless the tier itself is empty.
 *
 * @param {Catalog} catalog
 * @param {ResolveModelsOptions} [options]
 * @returns {string[]}
 */
export function resolveModels(
  catalog,
  { tier, count = 1, diversity = false, explicit, vendors } = /** @type {ResolveModelsOptions} */ ({}),
) {
  if (Array.isArray(explicit) && explicit.length > 0) return [...explicit];
  if (tier === undefined || !catalog.tiers[tier]) throw new Error(`unknown tier: ${tier}`);

  // Reverse-index: model → first-declared provider.
  /** @type {Map<string, string>} */
  const providerOf = new Map();
  for (const [provider, models] of Object.entries(catalog.providers || {})) {
    for (const m of models) {
      if (!providerOf.has(m)) providerOf.set(m, provider);
    }
  }

  let tierMembers = catalog.tiers[tier];
  if (Array.isArray(vendors) && vendors.length > 0) {
    const allow = new Set(vendors);
    tierMembers = tierMembers.filter((m) => allow.has(providerOf.get(m) ?? ''));
    if (tierMembers.length === 0) {
      throw new Error(`no models match tier "${tier}" with the configured vendor/adapter filters`);
    }
  }

  if (!diversity || count <= 1) {
    return tierMembers.slice(0, count);
  }

  // First pass: walk tier in order, accept first model per distinct provider.
  /** @type {Set<string>} */
  const seenProviders = new Set();
  /** @type {string[]} */
  const picked = [];
  for (const m of tierMembers) {
    const provider = providerOf.get(m) || `__unknown_${m}`;
    if (seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    picked.push(m);
    if (picked.length >= count) return picked;
  }

  // Top-up: append remaining members in order (skipping ones already picked).
  for (const m of tierMembers) {
    if (picked.includes(m)) continue;
    picked.push(m);
    if (picked.length >= count) break;
  }
  return picked;
}

/** @typedef {{ tiers: Record<string,string[]>, providers: Record<string,string[]>, aliases?: Record<string,string> }} ModelSource */

/**
 * Normalized model source for one adapter. Resolution order:
 *   1. `listModels()` — runtime discovery, when the adapter implements it
 *      AND returns a non-empty list. An empty list (or a thrown error) is
 *      treated as "discovery unavailable" and falls through to the static
 *      sources, so a broken CLI doesn't blow up panel resolution.
 *   2. `catalog` — the static catalog inlined on the adapter object. Preferred
 *      over reading from disk because the bundled server cannot resolve
 *      `defaultCatalogPath()` (see Adapter.catalog in types.d.ts).
 *   3. `defaultCatalogPath()` — read the on-disk catalog (codex's runtime
 *      cache; also a fallback for any adapter without an inlined catalog).
 * Tolerates a missing/malformed catalog by returning an empty source —
 * codex's cache may not exist before first use.
 *
 * @param {import('./types.d.ts').Adapter} adapter
 * @returns {Promise<ModelSource>}
 */
export async function getModelSource(adapter) {
  if (typeof adapter.listModels === 'function') {
    /** @type {import('./types.d.ts').ModelInfo[]} */
    let models = [];
    try {
      models = await adapter.listModels();
    } catch {
      models = [];
    }
    if (models.length > 0) {
      /** @type {ModelSource} */
      const src = { tiers: {}, providers: {}, aliases: adapter.catalog?.aliases };
      for (const m of models) {
        src.providers[m.vendor] ??= [];
        src.providers[m.vendor].push(m.slug);
        if (m.tier) {
          src.tiers[m.tier] ??= [];
          src.tiers[m.tier].push(m.slug);
        }
      }
      return src;
    }
  }
  if (adapter.catalog) {
    return {
      tiers: adapter.catalog.tiers ?? {},
      providers: adapter.catalog.providers ?? {},
      aliases: adapter.catalog.aliases,
    };
  }
  try {
    const raw = await readFile(adapter.defaultCatalogPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Adapters that ship a {tiers,providers} catalog (cursor, gemini) use it
    // directly. A catalog with only a `models` array (codex's model cache)
    // contributes to providers under the adapter's first vendor, no tiers.
    if (parsed.tiers || parsed.providers) {
      return { tiers: parsed.tiers ?? {}, providers: parsed.providers ?? {}, aliases: parsed.aliases };
    }
    if (Array.isArray(parsed.models)) {
      const vendor = adapter.vendors[0] ?? adapter.name;
      return {
        tiers: {},
        providers: { [vendor]: parsed.models.map((/** @type {{slug:string}} */ m) => m.slug) },
      };
    }
    return { tiers: {}, providers: {} };
  } catch {
    return { tiers: {}, providers: {} };
  }
}

/**
 * Merge the model sources of the named adapters into one Catalog. Tier and
 * provider arrays are concatenated and deduped (first occurrence wins order).
 * Alias maps are merged with the same first-occurrence-wins precedence: when
 * two adapters declare the same shorthand, the earlier adapter in the enabled
 * list keeps its value.
 *
 * Throws if any name in `adapterNames` is not a registered adapter — callers
 * pass the registry-validated `adapters.enabled` list, so an unknown name
 * there is a programming error worth surfacing. Contrast `expandAdapterFilter`
 * in `registry.mjs`, which silently skips unknown names because it operates on
 * user-supplied filter lists where a typo should be tolerated.
 *
 * @param {string[]} adapterNames
 * @returns {Promise<Catalog>}
 */
export async function loadMergedCatalog(adapterNames) {
  /** @type {Record<string,string[]>} */
  const tiers = {};
  /** @type {Record<string,string[]>} */
  const providers = {};
  /** @type {Record<string,string>} */
  const aliases = {};
  /** @param {Record<string,string[]>} target @param {Record<string,string[]>} add */
  const mergeInto = (target, add) => {
    for (const [k, list] of Object.entries(add)) {
      target[k] ??= [];
      const dest = target[k];
      for (const item of list) if (!dest.includes(item)) dest.push(item);
    }
  };
  for (const name of adapterNames) {
    const src = await getModelSource(getAdapter(name));
    mergeInto(tiers, src.tiers);
    mergeInto(providers, src.providers);
    if (src.aliases) {
      for (const [k, v] of Object.entries(src.aliases)) {
        if (!(k in aliases)) aliases[k] = v;
      }
    }
  }
  return { version: 'merged', updated_at: new Date().toISOString().slice(0, 10), tiers, providers, aliases };
}

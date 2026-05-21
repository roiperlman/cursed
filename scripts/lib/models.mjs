import { readFile } from 'node:fs/promises';

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
  { tier, count = 1, diversity = false, explicit } = /** @type {ResolveModelsOptions} */ ({}),
) {
  if (Array.isArray(explicit) && explicit.length > 0) return [...explicit];
  if (tier === undefined || !catalog.tiers[tier]) throw new Error(`unknown tier: ${tier}`);

  const tierMembers = catalog.tiers[tier];
  if (!diversity || count <= 1) {
    return tierMembers.slice(0, count);
  }

  // Build reverse-index: model → first-declared provider.
  /** @type {Map<string, string>} */
  const providerOf = new Map();
  for (const [provider, models] of Object.entries(catalog.providers || {})) {
    for (const m of models) {
      if (!providerOf.has(m)) providerOf.set(m, provider);
    }
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

  // Top-up: if providers exhausted before count met, walk tier again and
  // append remaining members in order (skipping ones already picked).
  for (const m of tierMembers) {
    if (picked.includes(m)) continue;
    picked.push(m);
    if (picked.length >= count) break;
  }
  return picked;
}

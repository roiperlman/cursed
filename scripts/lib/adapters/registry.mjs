import { readFile as fsReadFile } from 'node:fs/promises';
import cursorAdapter from './cursor/index.mjs';
import codexAdapter from './codex/index.mjs';
import geminiAdapter from './gemini/index.mjs';
import antigravityAdapter from './antigravity/index.mjs';
import { validateAdapter } from './contract.mjs';

/** @typedef {import('../types.d.ts').Adapter} Adapter */

/**
 * Registered adapters, keyed by `adapter.name`. Static; filesystem discovery
 * isn't worth the complexity until a real reason to make registration dynamic
 * shows up.
 *
 * @type {Readonly<Record<string, Adapter>>}
 */
const ADAPTERS = Object.freeze({
  [cursorAdapter.name]: cursorAdapter,
  [codexAdapter.name]: codexAdapter,
  [geminiAdapter.name]: geminiAdapter,
  [antigravityAdapter.name]: antigravityAdapter,
});

// Load-time gate: every entry must conform to the contract. A buggy adapter
// crashes the MCP server at startup rather than during a tool call, which
// is the right time to find out.
for (const a of Object.values(ADAPTERS)) validateAdapter(a);

/**
 * Resolve an adapter by name. Defaults to cursor for back-compat — Phase 1
 * call sites that don't yet pass a name still get cursor.
 *
 * Phase 2 #3 will derive the adapter name from a `model → adapter` mapping
 * built off the catalog `vendors`; callers will then pass an explicit name.
 *
 * @param {string} [name]
 * @returns {Adapter}
 */
export function getAdapter(name = 'cursor') {
  const a = ADAPTERS[name];
  if (!a) {
    const known = Object.keys(ADAPTERS).join(', ');
    throw new Error(`unknown adapter: "${name}" (registered: ${known})`);
  }
  return a;
}

/** @returns {string[]} */
export function listAdapters() {
  return Object.keys(ADAPTERS);
}

/** @returns {Adapter} */
export function defaultAdapter() {
  return cursorAdapter;
}

/**
 * Expand a list of adapter names to the deduped union of their `vendors`.
 * Used to turn an adapter allowlist into the vendor allowlist resolveModels
 * understands. Unknown names are skipped.
 *
 * @param {string[]} adapterNames
 * @returns {string[]}
 */
export function expandAdapterFilter(adapterNames) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const name of adapterNames) {
    const a = ADAPTERS[name];
    if (!a) continue;
    for (const v of a.vendors) out.add(v);
  }
  return [...out];
}

/**
 * Resolve the adapter for a given model id by checking each adapter's catalog
 * in turn — codex, then gemini, then antigravity. Returns the first adapter
 * whose catalog lists the model slug; falls back to cursor when no catalog
 * matches, or when a catalog is absent or malformed.
 *
 * Codex reads its catalog from disk (`~/.codex/models_cache.json` — a runtime
 * cache); gemini and antigravity use their inlined `adapter.catalog` so this
 * works inside the bundled MCP server, where `defaultCatalogPath()` would
 * otherwise resolve against the bundle's own location (see Adapter.catalog
 * in types.d.ts).
 *
 * @param {string} model
 * @param {{ _readFile?: (path: string, encoding: string) => Promise<string> }} [opts]
 * @returns {Promise<Adapter>}
 */
export async function adapterForModel(
  model,
  {
    _readFile = /** @type {(path: string, encoding: string) => Promise<string>} */ (
      /** @type {unknown} */ (fsReadFile)
    ),
  } = {},
) {
  try {
    const catalogPath = codexAdapter.defaultCatalogPath();
    const raw = await _readFile(catalogPath, 'utf8');
    const catalog = JSON.parse(raw);
    const slugs = (catalog.models ?? []).map((/** @type {{ slug: string }} */ m) => m.slug);
    if (slugs.includes(model)) return getAdapter('codex');
  } catch {
    // Missing or malformed catalog — fall through.
  }
  // Gemini and antigravity: inlined catalog (preferred), with _readFile as a
  // fallback for adapters that might omit `catalog` in the future. The on-disk
  // path doesn't work inside the bundled server.
  if (await catalogContains(geminiAdapter, model, _readFile)) return getAdapter('gemini');
  // Antigravity — `antigravity-default` lives only in this catalog, so there
  // is no collision with gemini's real slugs and no precedence rule.
  if (await catalogContains(antigravityAdapter, model, _readFile)) return getAdapter('antigravity');
  return getAdapter('cursor');
}

/**
 * Does `adapter`'s static catalog list `model`? Prefers the inlined
 * `adapter.catalog` (the bundled-safe path); falls back to reading
 * `defaultCatalogPath()` via the injected `_readFile` for adapters without
 * an inlined catalog. Catalog shape: `{ providers: Record<vendor, slug[]> }`.
 *
 * @param {Adapter} adapter
 * @param {string} model
 * @param {(path: string, encoding: string) => Promise<string>} _readFile
 * @returns {Promise<boolean>}
 */
async function catalogContains(adapter, model, _readFile) {
  if (adapter.catalog) {
    const slugs = Object.values(adapter.catalog.providers ?? {}).flat();
    return slugs.includes(model);
  }
  try {
    const raw = await _readFile(adapter.defaultCatalogPath(), 'utf8');
    const catalog = JSON.parse(raw);
    const slugs = Object.values(catalog.providers ?? {}).flat();
    return slugs.includes(model);
  } catch {
    return false;
  }
}

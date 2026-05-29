import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

/** @typedef {import('../../types.d.ts').ModelInfo} ModelInfo */

/**
 * Slugs codex maintains under `visibility: "hide"` are internal review/eval
 * helpers (e.g. `codex-auto-review`) that aren't user-selectable model ids
 * in practice. Filter them out of discovery so panel resolution doesn't try
 * to dispatch a run against one.
 */
const HIDDEN_VISIBILITY = 'hide';

/**
 * @typedef {object} ListModelsOptions
 * @property {string} [cachePath] - Override path to the codex models cache. Defaults to `~/.codex/models_cache.json`.
 * @property {(path: string, encoding: 'utf8') => Promise<string>} [_readFile] - Injectable for tests.
 */

/**
 * Runtime model discovery for the codex adapter. Reads the codex CLI's
 * server-fetched model cache at `~/.codex/models_cache.json` (also exposed
 * via `defaultCatalogPath()`).
 *
 * Returns `[]` when the cache is absent, malformed, or empty —
 * `getModelSource` interprets that as "fall back to the static path" so a
 * fresh codex install (which has no cache yet) still resolves models via
 * the `defaultCatalogPath()` read in `getModelSource`.
 *
 * @param {ListModelsOptions} [options]
 * @returns {Promise<ModelInfo[]>}
 */
export async function listModels({ cachePath, _readFile } = {}) {
  const path = cachePath || join(os.homedir(), '.codex', 'models_cache.json');
  /** @type {string} */
  let raw;
  try {
    raw = _readFile ? await _readFile(path, 'utf8') : await readFile(path, 'utf8');
  } catch {
    return [];
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const data = /** @type {{ models?: Array<{ slug?: string; visibility?: string }> }} */ (parsed);
  if (!Array.isArray(data.models)) return [];

  /** @type {ModelInfo[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const m of data.models) {
    if (!m || typeof m.slug !== 'string' || !m.slug) continue;
    if (m.visibility === HIDDEN_VISIBILITY) continue;
    if (seen.has(m.slug)) continue;
    seen.add(m.slug);
    out.push({ slug: m.slug, vendor: 'openai' });
  }
  return out;
}

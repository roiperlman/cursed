import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildCursorArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';
import { listModels } from './list-models.mjs';
import catalog from '../../../../models.default.json' with { type: 'json' };

/**
 * Model vendors reachable through cursor-agent today. Sourced from the
 * keys of `models.default.json:providers`. Declared here for the adapter
 * contract; not yet consumed by panel resolution (Phase 2 wires this in).
 *
 * `cursor` itself appears in the list because cursor-agent ships
 * cursor-branded models (composer-*) under its own vendor namespace
 * alongside the upstream-vendor proxies.
 *
 * @type {readonly string[]}
 */
const VENDORS = Object.freeze(['cursor', 'openai', 'anthropic', 'google', 'xai', 'moonshot']);

/**
 * Resolve the plugin root's `models.default.json`. Computed at call time so
 * a test that swaps the plugin root via env (rare, but possible) still
 * resolves correctly.
 *
 * Path: this file is at scripts/lib/adapters/cursor/index.mjs; the catalog
 * is at the repo root, four levels up.
 *
 * NOTE: this resolves against `import.meta.url`, which points at the bundle
 * (not this source file) once the server is bundled — so the path is wrong
 * in the bundled artifact. Model resolution uses the inlined `catalog` field
 * below instead; `defaultCatalogPath` is kept only for the adapter contract.
 *
 * @returns {string}
 */
function defaultCatalogPath() {
  return join(fileURLToPath(new URL('../../../../', import.meta.url)), 'models.default.json');
}

/** @type {import('../../types.d.ts').Adapter} */
const adapter = {
  name: 'cursor',
  api_version: 1,
  vendors: [...VENDORS],
  buildArgs: buildCursorArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  catalog,
  listModels,
  streamEventLabel,
};

export default adapter;

import { fileURLToPath } from 'node:url';
import { buildGeminiArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';
import catalog from './catalog.json' with { type: 'json' };

/**
 * Model vendors reachable through gemini-cli.
 *
 * @type {readonly string[]}
 */
const VENDORS = Object.freeze(['google']);

/**
 * Resolve the catalog this adapter ships. Path is computed at call time so
 * test-time relocations resolve correctly.
 *
 * NOTE: this resolves against `import.meta.url`, which points at the bundle
 * (not this source file) once the server is bundled — so the path is wrong
 * in the bundled artifact. Model resolution uses the inlined `catalog` field
 * below instead; `defaultCatalogPath` is kept only for the adapter contract.
 *
 * @returns {string}
 */
function defaultCatalogPath() {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

/** @type {import('../../types.d.ts').Adapter} */
const adapter = {
  name: 'gemini',
  api_version: 1,
  vendors: [...VENDORS],
  buildArgs: buildGeminiArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  catalog,
  streamEventLabel,
};

export default adapter;

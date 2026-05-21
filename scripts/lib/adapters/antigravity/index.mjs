import { fileURLToPath } from 'node:url';
import { buildAntigravityArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';

/**
 * Model vendors reachable through the Antigravity CLI. Declared as `google`
 * because antigravity is positioned as the Gemini-CLI successor; the CLI also
 * fronts other vendors interactively, but cursed has no lever to select them.
 *
 * @type {readonly string[]}
 */
const VENDORS = Object.freeze(['google']);

/**
 * Resolve the catalog this adapter ships. Path is computed at call time so
 * test-time relocations resolve correctly.
 *
 * @returns {string}
 */
function defaultCatalogPath() {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

/** @type {import('../../types.d.ts').Adapter} */
const adapter = {
  name: 'antigravity',
  api_version: 1,
  vendors: [...VENDORS],
  buildArgs: buildAntigravityArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  streamEventLabel,
};

export default adapter;

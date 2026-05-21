import { fileURLToPath } from 'node:url';
import { buildGeminiArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';

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
  streamEventLabel,
};

export default adapter;

import os from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';
import { listModels } from './list-models.mjs';

/**
 * Model vendors reachable through codex today. Codex is a ChatGPT-/OpenAI-
 * fronted CLI; with `OPENAI_API_KEY` it can reach other OpenAI-compatible
 * model ids too, but the only vendor on the wire is openai. Phase 2 #3 will
 * consume this for panel resolution.
 *
 * @type {readonly string[]}
 */
const VENDORS = Object.freeze(['openai']);

/**
 * Resolve the catalog codex maintains for available models. Codex fetches
 * this server-side and caches it at `~/.codex/models_cache.json`; cursed
 * doesn't ship its own copy.
 *
 * The file may not exist before codex has been run once (server-fetched on
 * first use). The contract test only asserts the path is absolute — caller
 * code that loads the catalog must tolerate a missing file gracefully.
 *
 * @returns {string}
 */
function defaultCatalogPath() {
  return join(os.homedir(), '.codex', 'models_cache.json');
}

/** @type {import('../../types.d.ts').Adapter} */
const adapter = {
  name: 'codex',
  api_version: 1,
  vendors: [...VENDORS],
  buildArgs: buildCodexArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  listModels,
  streamEventLabel,
};

export default adapter;

import { fileURLToPath } from 'node:url';
import { buildAntigravityArgs } from './args.mjs';
import { parseStream, streamEventLabel } from './parse.mjs';
import { probeSetup } from './probe.mjs';
import catalog from './catalog.json' with { type: 'json' };

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
  name: 'antigravity',
  api_version: 1,
  vendors: [...VENDORS],
  // `agy --print` writes plain-text narration (e.g. "I will list…") on stdout,
  // not NDJSON. The structured transcript lives in agy's own sidecar log; the
  // mirror file `runOne` writes is just a verbatim copy of stdout. ROI-68:
  // declare `text` so the mirror is named `.txt` and downstream tools don't
  // try to JSON.parse it.
  transcript_format: 'text',
  buildArgs: buildAntigravityArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  catalog,
  streamEventLabel,
};

export default adapter;

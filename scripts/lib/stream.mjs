// Thin re-export shim. The implementation lives at adapters/cursor/parse.mjs;
// this file exists so existing imports (`./stream.mjs`) keep working without
// modification through Phase 1. New code should import from the adapter
// surface (`./adapters/registry.mjs` or `./adapters/cursor/index.mjs`).
export { parseStream } from './adapters/cursor/parse.mjs';

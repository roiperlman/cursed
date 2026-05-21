# Adapters

`cursed` shells out to a CLI to talk to non-Claude models. The adapter registry currently covers four CLIs: cursor, codex, gemini, and antigravity. The **adapter** is the seam that lets us add a new CLI without touching `runOne`, `panel.mjs`, or any of the four user-facing commands. The `antigravity` adapter drives Google's `agy` CLI (the successor to Gemini CLI); because `agy` emits no structured stdout, its `parseStream` reads a sidecar `transcript.jsonl` file located via the run's working directory.

This doc is the contract reference. Read it before adding a new adapter.

## The contract

An adapter is a plain object with four functions and three declarative fields. The shape is in [`scripts/lib/types.d.ts`](../scripts/lib/types.d.ts):

```ts
interface Adapter {
  name: string;              // "cursor", "codex", … — also the directory name
  api_version: 1;            // bumps on breaking changes to this interface
  vendors: string[];         // model vendors reachable through this CLI
  buildArgs(input): { command, args, env };
  parseStream(raw): Promise<ParsedRun>;
  probeSetup(options?): Promise<SetupResult>;
  defaultCatalogPath(): string;
}
```

That's it. Every adapter lives at `scripts/lib/adapters/<name>/`, exports a default `Adapter` object from `index.mjs`, and is registered with one line in [`scripts/lib/adapters/registry.mjs`](../scripts/lib/adapters/registry.mjs).

### Field-by-field

**`name`** — Lowercase kebab. Matches the directory name. Used as the registry key and shows up in error messages.

**`api_version`** — Currently `1`. Bumps only when this interface itself changes.

**`vendors`** — The model vendors this CLI can route to. Cursor today: `['cursor', 'openai', 'anthropic', 'google', 'xai', 'moonshot']`. A single-vendor CLI (e.g. codex serving only OpenAI models) is `['openai']`. **The field is declared in Phase 1 but not yet consumed** — panel resolution still keys off `models.default.json:providers` directly. Phase 2 wires panel resolution through `effective_vendor_set = ⋃(adapter.vendors)`. Declare it accurately now so Phase 2 doesn't have to retrofit.

**`buildArgs({ prompt, model, resumeSessionId?, resumeLast?, extraEnv? })`** — Pure. Returns `{ command, args, env }` ready to hand to `child_process.spawn`. The cursor adapter at [`scripts/lib/adapters/cursor/args.mjs`](../scripts/lib/adapters/cursor/args.mjs) is the worked example. Resume semantics are adapter-specific: cursor distinguishes `--resume <id>` from `--continue`; a new CLI can map both to whatever it supports (or unconditionally start fresh, if neither is supported).

**`parseStream(raw, context?)`** — Async, takes the child's stdout (a string, or `null`/`undefined`) and an optional context object. Returns a [`ParsedRun`](../scripts/lib/types.d.ts). Must be tolerant: empty input, malformed JSON lines, mid-stream truncation all need to produce a well-formed `ParsedRun` with `errors: [...]` populated rather than throwing. The `context.cwd` field is the run's working directory; adapters whose CLI writes a sidecar transcript (e.g. antigravity, which resolves a `transcript.jsonl` via the conversation map at `~/.gemini/antigravity-cli/cache/last_conversations.json`) use it to locate that file — adapters that parse stdout directly ignore it. Cursor's NDJSON parser at [`scripts/lib/adapters/cursor/parse.mjs`](../scripts/lib/adapters/cursor/parse.mjs) is the reference; capture event shapes for new CLIs into `test/fixtures/streams/<adapter>/` (see fixture conventions below).

**`probeSetup(options?)`** — Async. Returns a [`SetupResult`](../scripts/lib/types.d.ts). The shape is one-CLI-shaped today (single `available`, `version`, `authenticated`, `providers_reachable`). When more than one adapter is registered, `/cursed:setup` probes the default one; per-adapter probing is a Phase 2 concern. `options` accepts `{ exec, env, authCheck }` for test injection — keep that pattern so unit tests can swap in fake exec without spawning real processes.

**`defaultCatalogPath()`** — Returns an absolute path to the JSON model catalog this adapter ships. Cursor returns the plugin-root `models.default.json`. Phase 1 keeps the catalog flat; Phase 2 will decide whether to split per adapter.

## Adding a new adapter

The cursor adapter is the worked example. Follow its shape.

1. **Create the directory:** `scripts/lib/adapters/<name>/`.
2. **Implement the four functions** in separate files (`args.mjs`, `parse.mjs`, `probe.mjs` is the cursor convention; nothing forces it — but the split is convenient for unit tests).
3. **Assemble `index.mjs`** exporting a default `Adapter` object:

   ```js
   import { buildArgs } from './args.mjs';
   import { parseStream } from './parse.mjs';
   import { probeSetup } from './probe.mjs';

   const VENDORS = ['openai']; // every vendor reachable through this CLI

   export default {
     name: 'codex',
     api_version: 1,
     vendors: [...VENDORS],
     buildArgs,
     parseStream,
     probeSetup,
     defaultCatalogPath() { /* return absolute path */ },
   };
   ```

4. **Register one line** in `scripts/lib/adapters/registry.mjs`:

   ```js
   import codexAdapter from './codex/index.mjs';
   const ADAPTERS = Object.freeze({
     [cursorAdapter.name]: cursorAdapter,
     [codexAdapter.name]: codexAdapter,
   });
   ```

   The `for (const a of Object.values(ADAPTERS)) validateAdapter(a)` line at load time will reject a malformed entry before the MCP server boots.

5. **The contract test** (`test/unit/adapters/contract.test.mjs`) auto-iterates every registered adapter. If the shape is right, this passes without any change to the test file.

6. **Capture stream fixtures** from a real CLI run (see below) and write `parseStream` against them. Don't hand-write fixtures — invariants drift.

## Stream-parser fixture conventions

Every adapter's `parseStream` is the surface most likely to silently regress when the upstream CLI ships a version bump. Fixtures pin the wire format we tested against.

- Location: `test/fixtures/streams/<adapter>/<scenario>.txt` (one NDJSON-ish blob per file).
- Captured from a real CLI run, not hand-written. Add a short header comment naming the CLI version, the invocation, and the date.
- One scenario per failure mode: happy path, tool calls, partial output, mid-stream error, malformed line, empty input.
- The corresponding unit test goes in `test/unit/adapters/<adapter>-parse.test.mjs` and loads fixtures from `test/fixtures/streams/<adapter>/`.

When upstream ships an incompatible change, the failing fixture test is the cheapest possible diff — you see the new event shape next to the old in the same PR.

## Registry semantics

Phase 1 keeps the registry intentionally static (one frozen map at the top of `registry.mjs`). Dynamic filesystem discovery would buy nothing while there's one adapter, and adds a load-order failure mode that has to be tested. When discovery becomes useful, replace the static map without changing the `getAdapter` / `listAdapters` / `defaultAdapter` surface; consumers shouldn't have to know.

## Where Phase 2 will pick this up

These are not Phase 1 concerns. Reading them helps you not paint Phase 1 into a corner:

- **Panel resolution by `vendors`.** Today's resolver uses `models.default.json:providers` directly. Phase 2 will switch to `effective_vendor_set = ⋃(adapter.vendors)` and add panel-collapse semantics when `requested_panel_size > |effective_vendor_set|`.
- **`--cli <name>` flag.** Not needed with one adapter. Phase 2 adds it for explicit dispatch.
- **`--models` namespacing.** Probably `cli:model` (e.g. `codex:gpt-5.4`) vs an adapter-priority resolver. Decision deferred to when the second adapter exists.
- **`SetupResult` shape.** Likely wraps to `{ adapters: SetupResult[] }`, or splits into a per-adapter MCP tool. Either way it's a breaking change — bundle with the `providers` → `vendors` rename so the wire-format change happens once.
- **Per-adapter catalog files.** `models.default.json` stays flat for now; split when there's a real reason.

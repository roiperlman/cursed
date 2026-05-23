# Contributing to cursed

Thanks for considering a contribution. `cursed` is small, opinionated, and changing fast — read this once before opening a PR so your work lands cleanly.

The single most valuable inbound contribution is **a new CLI adapter**. See [Adding a new adapter](#adding-a-new-adapter) below.

## Code of conduct

This project follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be kind, assume good faith, and keep critique focused on the code.

## Dev setup

```bash
git clone https://github.com/roiperlman/cursed.git
cd cursed
npm install
```

Node.js 20 or later is required (CI runs Node 22). To exercise the plugin against a live Claude Code session, see the [Loading the plugin](./README.md#loading-the-plugin) section of the README.

### Quality gates

Every PR must pass the same gates CI runs. Run them locally before pushing:

```bash
npm run typecheck      # tsc as JSDoc checker (no build output)
npm run lint           # biome lint
npm run format:check   # biome format --check (use `npm run format` to fix)
npm run build:check    # rebuild bundled MCP/job scripts + fail if the committed bundle is stale
npm test               # unit + smoke
```

Narrower entry points exist when you don't need the full sweep:

```bash
npm run test:unit      # unit tests only
npm run test:smoke     # smoke tests only
npm run test:e2e       # real model calls — requires TESTBED_E2E=1 and Claude auth
```

The e2e suite makes real model calls (Haiku is ~$0.0005/run); don't add it to CI without a budget guard.

## PR conventions

### Open an issue first for non-trivial changes

For anything beyond a typo, a doc tweak, or a small bug fix, open an issue first to agree on direction. New adapters in particular benefit from an upfront sketch — see [Adding a new adapter](#adding-a-new-adapter).

### Branch naming

Branch off `main`. Use a short prefix that names the kind of change:

- `feat/<slug>` — new feature or adapter (e.g. `feat/codex-adapter`)
- `fix/<slug>` — bug fix
- `docs/<slug>` — docs-only change
- `chore/<slug>` — tooling, deps, infra
- `refactor/<slug>` — internal restructuring with no behavior change

### Commit style

This repo uses [semantic-release](https://semantic-release.gitbook.io/), so commits follow [Conventional Commits](https://www.conventionalcommits.org/). The type prefix decides the next version bump:

- `feat: …` — minor bump
- `fix: …` — patch bump
- `chore: …`, `docs: …`, `refactor: …`, `test: …` — no release
- `feat!: …` or a `BREAKING CHANGE:` footer — major bump

Use a scope when it sharpens the diff: `feat(adapters): add codex CLI adapter`, `fix(panel): collapse to solo when only one vendor enabled`.

Squashing on merge is fine; the PR title becomes the squashed commit, so write it as a conventional commit too.

### CI expectations

`.github/workflows/ci.yml` runs `typecheck`, `lint`, `format:check`, `build:check`, and `test` on every push and PR. Anything that doesn't pass locally will not pass CI.

`build:check` is the one most contributors miss: if you edit `scripts/mcp/cursed-mcp.mjs` or any bundled source, you must commit a fresh bundle (`npm run build`). The check fails fast when the committed bundle drifts from source.

### What to include in the PR

- A short description of what changed and why.
- A note on how you verified the change (which tests, which scripts).
- For adapter PRs: a captured stream fixture and link to the CLI version you tested against.
- For user-visible changes: a one-line note for the README or relevant doc, if applicable.

Keep PRs scoped. Unrelated cleanups belong in their own PR.

## Adding a new adapter

Adapters are the seam that lets `cursed` route through a new CLI without touching `runOne`, `panel.mjs`, or any of the four user-facing commands. New adapters are the highest-leverage contribution to this project.

The full contract reference lives at [`docs/adapters.md`](./docs/adapters.md) — read it before writing code. The short version:

1. **Pick a CLI** that can drive at least one non-Claude model and emits a structured event stream (NDJSON over stdout is the easy case; sidecar transcript files work too — see the antigravity adapter).
2. **Create the directory** `scripts/lib/adapters/<name>/`. The cursor adapter at [`scripts/lib/adapters/cursor/`](./scripts/lib/adapters/cursor/) is the worked example — every other adapter follows its shape.
3. **Implement the four contract functions** in separate files (`args.mjs`, `parse.mjs`, `probe.mjs` is the cursor convention):
   - `buildArgs({ prompt, model, … })` — pure; returns `{ command, args, env }` ready for `child_process.spawn`.
   - `parseStream(raw, context?)` — tolerant; empty input, malformed JSON, mid-stream truncation must produce a well-formed `ParsedRun` with `errors: [...]` rather than throwing.
   - `probeSetup(options?)` — async; returns a `SetupResult` describing install / auth / reachability.
   - `defaultCatalogPath()` — absolute path to the JSON model catalog the adapter ships.
4. **Assemble `index.mjs`** exporting a default `Adapter` object with `name`, `api_version: 1`, `vendors`, and the four functions. The shape lives in [`scripts/lib/types.d.ts`](./scripts/lib/types.d.ts).
5. **Register the adapter** with one line in [`scripts/lib/adapters/registry.mjs`](./scripts/lib/adapters/registry.mjs). The `validateAdapter` pass at load time will reject a malformed entry before the MCP server boots.
6. **Capture stream fixtures from a real CLI run** under `test/fixtures/streams/<adapter>/<scenario>.txt`. Don't hand-write them — invariants drift. Include a short header naming the CLI version, the invocation, and the date. One file per failure mode: happy path, tool calls, partial output, mid-stream error, malformed line, empty input.
7. **Write the parse tests** at `test/unit/adapters/<name>-parse.test.mjs`, loading the fixtures from step 6. The contract test at `test/unit/adapters/contract.test.mjs` auto-iterates every registered adapter — if your shape is right, that one passes without any change.
8. **Add the adapter to the README's prerequisites and adapter list** so users know it exists. Update `docs/adapters.md` if the CLI introduces a wrinkle worth documenting (e.g. sidecar transcripts).

When in doubt, open an issue with a link to the CLI's docs and a paragraph on its event-stream shape. Adapter PRs are the most-welcomed kind of contribution here — make it easy for us to say yes.

## Reporting bugs

Open an issue with:

- What you ran (slash command + flags, or the underlying npm script).
- What you expected.
- What actually happened, including any stderr or JSONL transcript excerpts.
- Your environment (OS, Node version, which CLI adapters are installed).

For panel-related bugs, the full `cursed-job` artifact is the most useful thing to attach — it captures the raw event stream from every model in the run.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).

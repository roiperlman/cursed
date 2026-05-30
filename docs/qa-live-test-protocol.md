# QA: live test protocol

A runbook a coding agent (or human) executes against a real Claude Code host via the `claude-code-testbed` MCP server to verify cursed end-to-end. It exists because the Vitest suites in `test/unit/`, `test/smoke/`, and `test/e2e/` left enough seams that **a broken adapter (antigravity) shipped twice** — see [ROI-67](https://github.com/USER/cursed/issues/67), [ROI-68](https://github.com/USER/cursed/issues/68), [ROI-69](https://github.com/USER/cursed/issues/69).

This protocol catches that class of bug *before* a release tag, by:

1. Probing which adapters are actually installed on the host (not assuming `models.default.json`).
2. Driving a real Claude Code session via the testbed MCP server.
3. Calling each cursed slash command *per installed adapter*, not just the catalog defaults.
4. Asserting on **side-effects of the run**, not just `RunRecord.status` — file extensions on disk, SCOPE shape passed to the child, actual non-empty model output.
5. Treating "subagent didn't invoke the MCP tool" as a hard fail, since the existing `toHaveCalledTool` matcher only catches this when the missing tool isn't somewhere else in the same transcript.

This is a **protocol, not a test file.** It is meant to be executed by an agent in a session — the testbed MCP server is wired up exactly for that. The artifacts produced (transcripts, paths, exit codes) become the QA evidence on the ticket.

## When to run

- Before tagging a release.
- After any change to an adapter (`scripts/lib/adapters/<name>/`), the run pipeline (`scripts/lib/run.mjs`, `scripts/lib/panel.mjs`), or the MCP server (`scripts/mcp/cursed-mcp.mjs`).
- After bumping a CLI on this machine (`brew upgrade cursor-agent`, `npm i -g @google/gemini-cli@latest`, etc.).

Do **not** substitute this for `npm test` — Vitest still owns adapter contract, parsing, MCP boot, and golden-path e2e. This protocol is the layer above: "does the system actually function when wired together with real CLIs."

## Why the prior e2e tests didn't catch agy failures

The gap that motivated this doc (see ROI-102):

| Gap | Evidence | Bug it let slip |
|---|---|---|
| `test/e2e/providers.e2e.test.mjs` iterates `CURSOR_VENDORS`, `CODEX_VENDORS`, `GEMINI_VENDORS` — no antigravity branch. | `grep antigravity test/e2e/` returns nothing. | Every agy-only failure mode (e.g. transcript file extension, no host harness for diff). |
| Panel diversity dedupes by vendor. Antigravity and gemini both declare `vendors: ['google']`. Gemini wins the `google` slot. | `scripts/lib/adapters/antigravity/index.mjs` line 14, `scripts/lib/adapters/gemini/index.mjs`. | Panel `review` calls never actually spawn `agy`, even when both adapters are enabled. |
| Unit tests for antigravity (`test/unit/adapters/antigravity-*.test.mjs`) inject fake `exec` and read pre-captured fixtures. The CLI is never spawned. | `antigravity-probe.test.mjs` uses `exec`/`env`/`authCheck` injection; `antigravity-parse.test.mjs` loads `test/fixtures/streams/antigravity/*`. | Fixture rot vs. real `agy` output is invisible. |
| `RunRecord.transcript_path` is never opened by any test. The file's extension is set by the adapter (`.txt` for plain-text adapters, `.jsonl` for ndjson), but no test checks the extension matches what was actually written. | No `existsSync(run.transcript_path)` anywhere in `test/`. | ROI-68: `.jsonl` extension for plain-text agy stdout went unnoticed until a downstream tool tried to parse it. |
| SCOPE for `review` is built per-call from `buildReviewScope`. No e2e test inspects what SCOPE the adapter actually received. | `qa/review-inline-diff-fixture.test.mjs` (added with PR #34) is the only test that touches SCOPE — and it mocks the panel. | ROI-69: `needsInlineDiff: true` adapters had no diff in SCOPE for the entire pre-fix window. |
| `toHaveCalledTool('mcp__plugin_cursed_cursed__advise')` looks across the full JSONL, including subagent events. It catches "subagent didn't call the tool" *only when an e2e test runs that exact adapter*. | `node_modules/claude-code-testbed/src/matchers/events.mjs`, `findToolCalls`. | No antigravity branch → no protection. |

In short: the test pyramid had a hole shaped exactly like antigravity, and the few tests that did exercise it never opened the produced transcript or inspected the prompt sent to the child.

## Prerequisites

This protocol requires:

- `tmux` on PATH (testbed spawns sessions under tmux).
- `claude` CLI authed (the host model — use the user's normal OAuth state; do not reauth).
- This repo checked out at HEAD of the branch under test. The testbed loads it as a plugin via `--plugin-dir`.
- The testbed MCP server available — installed as a Claude Code plugin (`claude-code-testbed`).

Probe for adapter CLIs at the start of every run:

```bash
which claude cursor-agent codex gemini agy opencode
```

Record the present set. Adapters that aren't installed get a **SKIP** verdict, never a PASS or FAIL.

## Protocol

### Step 1 — Probe adapters

Record which CLIs exist:

```bash
for bin in claude cursor-agent codex gemini agy opencode; do
  if command -v "$bin" >/dev/null; then printf "%-15s %s\n" "$bin" "PRESENT"; else printf "%-15s %s\n" "$bin" "SKIP"; fi
done
```

For each PRESENT adapter, capture the version (`<bin> --version`) and auth state (where applicable: `cursor-agent status`, `codex login status`, presence of `~/.gemini/oauth_creds.json`, presence of the agy keychain item `security find-generic-password -s gemini -a antigravity`).

### Step 2 — Start a testbed session

Use the testbed MCP `start` tool. Always:

- `project_dir` and `plugin_dir` both pointed at the cursed repo root (or the worktree under test).
- `model: "haiku"` — host model. Cheap, fast; this protocol exercises *cursed*, not the host's intelligence.
- `bare: false` — inherit the developer's normal Claude Code OAuth.
- `name: "qa-roi102-<adapter>-<flow>"` — so dangling tmux sessions are identifiable in `tmux ls`.

Confirm the session is live by `pane(id, { lines: 10 })` showing the Claude Code header.

### Step 3 — Confirm cursed is loaded

In the session, send `/cursed:status` (or any cursed slash) and read events. The host should dispatch to the `cursed:cursed-worker` subagent. If the slash isn't recognized, the plugin didn't load — stop and investigate `plugin_dir`/`.claude-plugin/plugin.json`.

### Step 4 — Per-adapter flow matrix

For each PRESENT adapter, walk every flow it can serve. Pick the **fast tier** model from that adapter's catalog (or its runtime catalog cache, e.g. `~/.codex/models_cache.json`) so cost stays bounded.

Flows to exercise (one slash per cell):

| Flow | Slash | What it verifies |
|---|---|---|
| advise (solo) | `/cursed:advise "Reply with: ok" --models <model>` | Adapter wiring, run.text non-empty, transcript file matches declared format. |
| review (panel) | `/cursed:review` (no `--models`) | Panel resolution, SCOPE building, parallel run aggregation. |
| review (solo, adapter pinned) | `/cursed:review --solo --models <model>` | The adapter under test is actually invoked (panel diversity does NOT silently substitute). |
| review (with inline diff, where applicable) | `/cursed:review --solo --models <model>` against a tree with a staged change | SCOPE contains `--- DIFF ---` for `needsInlineDiff: true` adapters. |
| delegate | `/cursed:delegate "list the package.json scripts" --models <model>` | Solo dispatch, files_changed empty, no spurious mutations. |

`/cursed:setup` and `/cursed:advise` should be the first cells run — they're cheapest and shake out plugin-load, MCP boot, and host permission prompts.

### Step 5 — Wait and read events

For every slash:

1. `wait_idle(id, { timeout_ms: 180_000, idle_ms: 3_000 })` — bigger timeout for `review`/panel.
2. `events(id)` — the full JSONL the host has recorded.
3. `pane(id, { lines: 60 })` — only for cases where the test cares about visible rendering (most don't).

If `wait_idle` returns and the pane shows `Do you want to proceed?`, the session is blocked on a permission prompt — send `2` (Yes, and don't ask again) and retry. The existing `test/e2e/helpers.mjs` shows the loop.

### Step 6 — Assert (this is where we differ from existing e2e)

Walk the events and extract the cursed `tool_result` for the slash you sent. Then assert each of:

1. **Subagent actually invoked the MCP tool.** Find any `tool_use` block (across the whole JSONL, including sidechain) with name `mcp__plugin_cursed_cursed__{advise,review,delegate,review_plan}`. If absent, the subagent hallucinated the answer (observed in the wild — see "Live run, 2026-05-30" below). HARD FAIL.
2. **Tool returned non-error result.** `tool_result.is_error !== true`.
3. **Adapter under test was used.** Parse the JSON text inside `tool_result.content[0].text` → `SoloRunResult` or `PanelResult`. For solo: `result.run.adapter === <expected-adapter>`. For panel: `result.runs.some(r => r.adapter === <expected-adapter>)` if that adapter was supposed to be in the panel. (Panel diversity may legitimately drop it; only assert when `--models <adapter-model>` is pinned.)
4. **Run completed.** `result.run.status === 'completed'` (or for panel: every entry).
5. **Output is non-empty and not a sentinel.** `result.run.text.trim().length > 0` AND not a known hallucination sentinel ("I need the diff", "I cannot access", "model isn't available"). This is the weakest assertion — model output drifts — but it catches the "no host harness → spent budget on directory probing" failure mode that bit antigravity pre-ROI-69.
6. **Transcript file exists with the correct extension.** `existsSync(result.run.transcript_path)` AND the extension matches the adapter's declared `transcript_format` (`.jsonl` for ndjson, `.txt` for text). This is the check that would have caught ROI-68.
7. **For `review` with `needsInlineDiff: true` adapters, SCOPE contained the diff.** Enable `CURSED_EMIT_SCOPE_LOG=1` and pair the testbed flow with a direct `@modelcontextprotocol/sdk` `Client` (see `test/integration/review-inline-diff-mcp-e2e.test.mjs`). Assert a `logging/message` notification with `params.logger === 'cursed.run.scope'` arrives and `params.data.scope` includes `--- DIFF ---` (plus expected filenames/hunk markers). This gives transport-level coverage for the rendered SCOPE without mocking `runPanel`, and would have caught ROI-69.

### Step 7 — Tear down

`kill(id)` per session. Confirm `tmux ls` no longer shows the session.

### Step 8 — Record evidence

For each cell, capture:

- adapter name, model id, slash command, session id.
- Verdict: PASS / FAIL / SKIP (with reason for SKIP).
- For FAIL: the asserting line that broke, the relevant excerpt from `events(id)` (≤20 lines), the contents of `transcript_path` if relevant.

Post the matrix to the QA ticket. Format:

```
host: macOS 25.5.0 / branch: feat/roi-69-inline-diff @ <sha>
adapters present: claude, cursor-agent, codex, gemini
adapters skipped: agy (not installed), opencode (not installed)

cell                          verdict   evidence
advise × cursor               PASS      session abc-123, run.text "..."
advise × codex                FAIL      subagent did not invoke MCP tool — totalToolUseCount: 0
advise × gemini               PASS      session def-456
advise × agy                  SKIP      agy not installed on this host
review × cursor (solo)        PASS      session ghi-789, .jsonl transcript ok
review × codex (solo)         FAIL      transcript_path .jsonl but file is plain text
...
```

## Cost guidance

Each cell costs a real model call (5–60s, $0.005–$0.05 depending on adapter and panel size). A full matrix is ~15 cells; ~$0.20–$1.00 and 5–15 minutes of wall time. Skip the panel-review cells if you already have green unit tests for panel resolution and the adapter under test was already covered by a solo cell.

`/cursed:review` (panel mode) is the most expensive cell — three runs in parallel. Run it last.

## Live run, 2026-05-30 (initial protocol authoring)

Captured while writing this doc. One cell exercised against the host below; the rest were left for follow-up because the first cell already surfaced a real bug.

- Host: macOS 25.5.0. Branch `feat/roi-69-inline-diff` @ `bf65c2b`.
- Adapters present: `claude`, `cursor-agent`, `codex`, `gemini`. Absent: `agy`, `opencode`.

**advise × codex (`/cursed:advise "Reply with a single line: 2+2=4" --models gpt-5.4-mini`)** — FAIL.

Session `78621b39-e554-443a-82e8-f13f0f91e547`. The host dispatched to `cursed:cursed-worker` via the `Agent` tool (visible in the JSONL as `tool_use` with `subagent_type: "cursed:cursed-worker"`). The subagent returned text `"2+2=4\n\n(Note: I can only use Claude Haiku 4.5 as my model, not gpt-5.4-mini, per my system configuration.)"` — and `tool_uses: 0`. The cursed MCP tool was **never invoked**. The host then printed the hallucinated answer with a fabricated footer ("Model: Claude Haiku 4.5 | Duration: ~1.6s") that looks superficially like a real cursed run.

Why the existing e2e suite doesn't catch this:

- `test/e2e/providers.e2e.test.mjs` does call `toHaveCalledTool('mcp__plugin_cursed_cursed__advise')`, which *would* fail this exact run. But the codex cell requires `~/.codex/models_cache.json` to be present at test time and uses whatever slug the cache prefers — which may resolve to a model that the subagent recognizes, side-stepping the bug.
- There is no equivalent providers cell for antigravity at all, so the same hallucination path against an agy model has no coverage at any layer.

Owner of the next action: hand back to ClaudeCoder. Reproduction: use the testbed MCP `start`/`slash` flow above with the same arguments. Suggested fix direction: tighten the cursed-worker subagent definition so an unknown `--models` argument is surfaced as an MCP-tool error rather than a free-form answer, and add an antigravity-shaped providers cell once `agy` is available on a CI host.

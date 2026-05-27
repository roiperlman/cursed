# Testbed — Usage Practice

`claude-code-testbed` programmatically drives a real Claude Code session under tmux with this repo loaded as a plugin (`--plugin-dir`). It exists so we don't ask a human to open a fresh Claude Code window and click around — almost everything a human would do to "observe the host" is reachable through the testbed's API.

The high-level pointer is in [`CLAUDE.md`](../CLAUDE.md#the-testbed). This file is the long-form practice doc: where scripts live, how to skip, how to clean up, how to keep token cost down, when *not* to use it.

## When to use the testbed

**Use it when** the question is "what does the *host* (Claude Code) do with this?" — rendering of MCP notifications, plugin discovery, slash-command behavior, tool permission prompts, JSONL transcript shape. The testbed is the only programmable way to answer those questions; everything else (asking the user to restart Claude Code, paste a screenshot, read a chat panel) is a manual loop we want to avoid.

**Don't use it when** the question is "what does the *adapter* / *parser* / *server logic* do on a given input?" — those have lower-cost answers. Adapter behavior → `test/unit/adapters/*.test.mjs` against fixtures. MCP server logic → `test/smoke/mcp-startup.test.mjs` against a direct `@modelcontextprotocol/sdk` Client (no host involved). The testbed costs a real model call and 5–60s per scenario; reach for it after the cheaper layers have already passed.

## File layout and naming

| Location | Purpose | Cost gate |
|---|---|---|
| `test/unit/`            | Adapter, parser, registry, contract. Pure functions or fakes only. | Always runs in CI. |
| `test/smoke/`           | MCP server boot via direct `@modelcontextprotocol/sdk` Client. No host, no model spawn. Cheap. | Always runs in CI. |
| `test/integration/`     | Real model calls, real host (testbed), real worktree mutations. Slow, costs tokens. | Opt-in: `it.skipIf(...)`-gated on env; not run by CI by default. |
| `claude-code-testbed`   | Testbed package (devDependency). Don't put feature tests here. | n/a |

Naming: `test/integration/<thing>-mcp-e2e.test.mjs` (when the testbed is involved) or `<thing>-e2e.test.mjs` (when it's a direct CLI / spawn integration). The `-mcp-` infix is reserved for tests that boot the host.

## Skip conditions

The testbed has *three* skip layers, each independent:

1. **Host boot prerequisites** — `bare: true` (default) requires `ANTHROPIC_API_KEY`; `bare: false` requires that the developer has run `claude login` and the OAuth credentials are in the keychain. The testbed `start()` will hang or fail at the prompt-wait if either is missing.
2. **Plugin prerequisites** — the cursed plugin won't load if `.claude-plugin/plugin.json` references a binary the developer doesn't have. Today that's the cursor-agent CLI (always required) and codex (required only when a test exercises a codex code path).
3. **Test-specific prerequisites** — e.g. `OPENAI_API_KEY` for tests that target the codex adapter while running with API-tier model ids.

Skip pattern:

```javascript
import { it } from 'vitest';

const canRunCodexE2E = async () => {
  try {
    const { stdout } = await exec('codex --version');
    return /codex-cli/.test(stdout);
  } catch {
    return false;
  }
};

it.skipIf(!(await canRunCodexE2E()))('runs codex through the MCP layer', async () => {
  // ...
});
```

Don't write tests that *fail* when codex is missing — they should *skip*. CI without the env stays green; developers with the env see the test run.

## Boot conventions

```javascript
const session = await start({
  bare: false,      // default is true; flip to false when you want OAuth (no API key)
  pluginDir: REPO_ROOT,  // default is projectDir = process.cwd()
  model: 'haiku',   // host model. Cheap, fast. Only matters for the user-facing turn.
  name: 'codex-mcp-e2e', // optional; surfaces in `cursed:list-testbed-sessions`
});
```

- **Always set `name`** so a dangling session is identifiable in `tmux ls`.
- **Always set `model: 'haiku'`** unless the test is specifically about a different model. The test is about the cursed MCP layer, not host quality.
- **Use `bare: false` by default** — `bare: true` needs `ANTHROPIC_API_KEY` as an extra prerequisite, and most tests don't care about isolation from the developer's normal Claude Code state.
- **Don't pass `--allow-dangerously-skip-permissions`'s logical opposite.** The testbed already passes that flag; the gotcha is that it *enables* the bypass option, not that it auto-skips prompts. See the gotcha in CLAUDE.md.

## Driving the session

```javascript
await slash(session.id, '/cursed:advise "what is 1+1"');
await waitIdle(session.id, { timeoutMs: 120_000, idleMs: 3000 });

const evs = await events(session.id);             // JSONL the host recorded
const screen = await pane(session.id, { lines: 200 }); // tmux scrollback
```

Three rules:

1. **Always `waitIdle` before reading events.** The JSONL is appended asynchronously; reading it mid-turn gives a partial transcript. Default `idleMs: 2000` is usually enough; 3–5s for tool-heavy turns.
2. **Prefer `events()` over `pane()` for assertions.** The JSONL is what the host *records*; the tmux pane is what a human *sees*. JSONL is more stable across cosmetic UI changes. Use `pane()` only when the question is specifically about visible rendering.
3. **Set generous `timeoutMs`.** Real model calls take 5–30s; tool-using turns take longer. 120s is a reasonable default for solo runs; 5+ min for panel runs.

## Asserting on events

The JSONL transcript is a stream of `{ type, ... }` records. Key event types:

- `user` — the user message you sent via `send`/`slash`.
- `assistant` — host model output (text and tool_use blocks).
- `tool_use` — the host called an MCP tool. Has `name` (e.g. `'advise'`) and `id`.
- `tool_result` — the MCP tool's response. Has `tool_use_id` (matches the `tool_use.id`) and `structured_content` (the SoloRunResult / PanelResult).
- `logging/message` — MCP `notifications/message` (per Phase 1.5 streaming). Has `params.logger` (e.g. `'cursed.run'`) and `params.data`.
- `notifications/progress` — MCP progress ticks.

Assertion patterns that hold up across UI revisions:

```javascript
// Match by tool_use_id, not by ordinal — the host can interleave events.
const toolUse = evs.find((e) => e.type === 'tool_use' && e.name === 'advise');
const toolResult = evs.find((e) => e.type === 'tool_result' && e.tool_use_id === toolUse.id);
expect(toolResult.is_error).not.toBe(true);

// Assert on structured_content (the SoloRunResult), not on the rendered text.
const sc = toolResult.structured_content;
expect(sc.panel).toBe(false);
expect(sc.run.session_id).toMatch(/^[0-9a-f-]{36}$/);

// Progress notifications: count by logger, not by total event count.
const progressEvs = evs.filter((e) => e.type === 'logging/message' && e.params?.logger === 'cursed.run');
expect(progressEvs.length).toBeGreaterThanOrEqual(2); // entry + exit at minimum
```

## Cleanup

The testbed registry persists session info across processes. A `kill` that doesn't run leaks a tmux session. Always:

```javascript
afterEach(async () => {
  if (session) await kill(session.id);
});
```

If a test crashes before `kill`, dangling sessions show up in `tmux ls` as `testbed-<8 char id>`. Clean up with `tmux kill-session -t testbed-<id>` or `npm run testbed -- list`.

## Token budget guidance

Each testbed scenario costs:

| Tool | Model calls | Cost order |
|---|---|---|
| `cursed:advise` | 1 solo run | $ |
| `cursed:review` | 3 panel runs by default | $$$ |
| `cursed:delegate` | 1 long run | $$ |
| `cursed:review_plan` | 3 panel runs | $$$ |

Plus the host model's turn (haiku, negligible). For golden-path coverage, `advise` is almost always the right choice — solo, fast, cheap. Move to `review`/`review_plan` only when the test is specifically about panel orchestration or aggregation.

## Pairing with a direct MCP client

The testbed observes what the *host* does with MCP traffic. To know what's happening on the *wire* (separate from host rendering), pair the testbed with a direct `@modelcontextprotocol/sdk` `Client` connected over `StdioClientTransport`. `test/smoke/mcp-startup.test.mjs` is the canonical example.

Pair them when the question is **"is the host dropping/buffering/transforming this?"** The direct client gives you a positive control: if the wire payload is correct but the host doesn't render it, the bug is in the host's rendering — not in cursed.

For most tests you'll only need the testbed-alone path. Reach for the pair only when an assertion that should pass is failing and you don't yet know which side of the wire is at fault.

## Common gotchas

1. **`--allow-dangerously-skip-permissions` only enables the bypass; it doesn't auto-skip prompts.** If the JSONL is empty 3s after a tool call, the session is probably blocked on a `Do you want to proceed?` permission prompt. Capture the pane, detect the prompt, and `tmux.sendLiteral(name, '2')` + `tmux.sendKey(name, 'Enter')` for "Yes, and don't ask again." (The actual auto-skip flag is `--dangerously-skip-permissions`; the testbed doesn't surface it yet.)

2. **Plugin reload doesn't happen mid-session.** If you edit a file in `scripts/lib/` mid-test, the running session keeps the *old* plugin code. `kill` and `start` a new session to pick up changes. The testbed isn't a hot-reload environment.

3. **`waitIdle` returns when the *host* is idle, not when a *background MCP job* completes.** `cursed:delegate({ background: true })` returns a `BackgroundJobHandle` immediately; the actual job runs in a side process. To wait for the background job, poll `cursed:status` from inside the testbed or read `<workspaceDir>/jobs/<id>/result.json` from the test directly.

4. **The JSONL path is `~/.claude/projects/<encoded-dir>/<id>.jsonl`.** Encoded-dir replaces `/` with `-`. The testbed surfaces `jsonlPath` on the start return value — use it directly rather than recomputing.

5. **Don't read fixtures from outside `test/fixtures/streams/`.** If a test wants to compare against a captured stream, the stream belongs in `test/fixtures/`. The testbed produces *live* output; comparing live-against-fixture is fine, but checking fixtures *into* the testbed package muddies the separation.

## Reference examples

- **Pure direct-client (no testbed):** `test/smoke/mcp-startup.test.mjs`.
- **Testbed for stream progress (the original case study):** `docs/superpowers/plans/2026-05-04-cursed-stream-progress-spike.md`.
- **Plan that walks through a full testbed E2E for the codex adapter:** `docs/superpowers/plans/2026-05-14-codex-adapter-testbed.md`.

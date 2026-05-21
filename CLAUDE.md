# CLAUDE.md

Notes for Claude Code agents working in this repo.

## Adapters

Non-Claude CLIs are reached through a pluggable adapter at `scripts/lib/adapters/<name>/`. The contract and the steps to add a new one are in [`docs/adapters.md`](./docs/adapters.md). Phase 1 (cursor-only) is internal and zero-behavior-change; Phase 2 (codex + vendor-based panel resolution) is the breaking-change window.

## The testbed

`claude-code-testbed` (`lib.mjs`, plus a CLI wrapper) spawns a real Claude Code CLI session under tmux with this repo loaded as a plugin (`--plugin-dir`). It's how we exercise plugin behavior end-to-end without making a human open a fresh window.

**Reach for it whenever a task says "manual UI observation," "restart Claude Code and watch X," or otherwise asks a human to drive the host.** Almost always programmable — what looks like a manual observation step can usually become a one-shot script with a JSONL artifact.

**Don't use the testbed for questions a unit test or a direct MCP client can answer** — it costs a real model call and 5–60s per scenario. Adapter behavior → `test/unit/adapters/`. MCP server logic → `test/smoke/mcp-startup.test.mjs`. Only host-side behavior justifies the testbed.

Full usage practice — where scripts live, skip patterns, cleanup, token budget, common gotchas — is in [`docs/testbed.md`](./docs/testbed.md). Read it before writing a new testbed-driven test.

API surface (read the [claude-code-testbed](https://github.com/YOUR_USER/claude-code-testbed) source for full signatures):

- `start({ projectDir, pluginDir, model, bare, name })` → `{ id, tmuxName, jsonlPath }`. With `bare: false`, uses your normal OAuth credentials (the testbed default `bare: true` requires `ANTHROPIC_API_KEY`).
- `send(id, text)` / `slash(id, '/foo')` — feed user input.
- `events(id, { since })` — read the persisted JSONL transcript (the same file Claude Code records to `~/.claude/projects/<encoded-dir>/<id>.jsonl`).
- `pane(id, { lines })` — capture tmux scrollback. Useful for what a human would *see*; the JSONL is what the host *records*.
- `tail(id)` — async iterator of events as they're appended.
- `waitIdle(id, { timeoutMs, idleMs })` — block until the model finishes responding.
- `kill(id)` — tear down. Wire it into `afterEach` so a crashed test doesn't leak a tmux session.

### Pattern: testbed alone vs testbed + direct MCP client

The testbed observes what the **host** does with MCP traffic. To know what's happening on the **wire** (separate from host rendering), pair it with a direct `@modelcontextprotocol/sdk` `Client` connected over `StdioClientTransport`. `test/smoke/mcp-startup.test.mjs` is the canonical example. Run both when the question is "is the host dropping/buffering/transforming this?" — the direct client gives you a positive control.

### Gotcha: `--allow-dangerously-skip-permissions`

`lib.start()` passes `--allow-dangerously-skip-permissions` to claude, which only **enables the bypass option** — it doesn't actively skip MCP-tool permission prompts. If the testbed appears to hang at ~3s with nothing in the JSONL, capture the pane and check for a `Do you want to proceed?` prompt. Workaround: poll the pane, detect the prompt, and `tmux.sendLiteral(name, '2')` + `tmux.sendKey(name, 'Enter')` to pick the "Yes, and don't ask again" option. (The actual bypass flag is `--dangerously-skip-permissions` without the `allow-` prefix; the testbed doesn't surface it yet.)

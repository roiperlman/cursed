# cursed

[![CI](https://github.com/roiperlman/cursed/actions/workflows/ci.yml/badge.svg)](https://github.com/roiperlman/cursed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7B61FF.svg)](https://claude.com/claude-code)
[![MCP](https://img.shields.io/badge/MCP-native-0a7ea4.svg)](https://modelcontextprotocol.io)
[![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa.svg)](https://biomejs.dev)

> Hand narrow, well-shaped tasks from Claude Code to non-Anthropic models — through the Cursor CLI — for multi-model **code review**, **plan verification**, **scoped delegation**, and **decisive advice**.

**Why?** Three adversarial reviewers from different providers catch different bugs. Convergence is signal; divergence is noise; both are useful. `cursed` plugs Cursor's multi-provider router into Claude Code so a single slash command can spin up GPT, Gemini, and Grok in parallel and let parent Claude synthesize the result.

> **Unofficial community tool.** Not affiliated with, endorsed by, or sponsored by Anthropic or Anysphere. "Claude" is a trademark of Anthropic. "Cursor" is a trademark of Anysphere.

## What it does

Four commands, each with a baked-in stance:

| Command | Default mode | Purpose |
|---|---|---|
| `/cursed:review` | 3-model panel | Adversarial review of a diff. Convergence = real issue; divergence = noise. |
| `/cursed:plan-review` | solo (panel-capable) | Verify a written plan against the actual code it claims to modify. |
| `/cursed:delegate` | solo | Hand a scoped task to a non-Claude model. Writes to your tree, or to an isolated worktree. |
| `/cursed:advise` | solo | Ask a non-Claude advisor for decisive guidance at a decision point. |

Plus `/cursed:setup` to verify your `cursor-agent` install.

## Prerequisites

- Node.js 20 or later
- Cursor CLI (`cursor-agent`) installed and authenticated — [install guide](https://cursor.com/docs/cli/headless). Set `CURSOR_API_KEY` or run `cursor login`.
- Claude Code

## Install

```bash
git clone https://github.com/roiperlman/cursed ~/.claude/plugins/cursed
cd ~/.claude/plugins/cursed
npm install
```

Restart Claude Code. The `/cursed:*` commands and the `using-cursed` skill become available.

Run `/cursed:setup` once to verify `cursor-agent` is reachable and authenticated.

## Commands

### `/cursed:setup`
Probes `cursor-agent` for version and auth status.

### `/cursed:review [<path>|--target <ref>] [--models <model>]`
Adversarial code review. Defaults to the diff between the current branch and `main`. Runs a 3-model panel by default — one model per provider, in tier order.

### `/cursed:plan-review <plan-file> [--models <model>]`
Verifies a written plan against the actual code it claims to modify.

### `/cursed:advise "<question>" [--context-file <path>] [--models <model>]`
Ask a non-Claude advisor for decisive guidance. Returns a plan, a correction, or a stop signal.

### `/cursed:delegate "<task>" [--models <model>] [--worktree <name>] [--background]`
Hand a scoped task to a non-Claude model.

**Worktree isolation:** pass `--worktree <name>` to run inside a fresh git worktree at `.cursed/worktrees/<name>/`. Branch is retained on success; directory is auto-cleaned on failure.

**Background mode** (for long tasks): combine `--worktree` with `--background` to detach. The call returns immediately; the worker writes its result to disk when done.

```
/cursed:delegate "refactor module X" --worktree refactor-x --background
/cursed:status              # list all background jobs in this workspace
/cursed:status refactor-x   # detail for one job
/cursed:cancel refactor-x   # stop (~10s, SIGTERM → SIGKILL)
/cursed:result refactor-x   # full result once terminal
```

Background jobs survive Claude Code restarts and are GC'd after `[delegate.background].retention_days` (default 7 days).

## Configuration

Optional TOML file at `$CLAUDE_PLUGIN_DATA/config.toml`:

```toml
[defaults]
silence_timeout_seconds = 120
total_timeout_seconds = 1200

[commands.advise]
total_timeout_seconds = 1800
```

Full config reference: [`scripts/lib/config.mjs`](scripts/lib/config.mjs).

## How it works

```
Claude Code (parent)
    │
    ├── slash command  →  cursed MCP server  →  cursor-agent  →  GPT / Gemini / Grok
    │                                              (one or more models in parallel)
    │
    └── cursed-worker subagent synthesizes panel results back into parent context
```

The MCP server (`scripts/mcp/cursed-mcp.mjs`) is declared in the plugin manifest. Commands route through it; end users interact only with the slash commands. The `using-cursed` skill enables autonomous Claude to discover and call them without explicit instruction.

## Adapters

Non-Claude CLIs are reached through a pluggable adapter layer at `scripts/lib/adapters/<name>/`. Cursor (`cursor-agent`) is the default and ships with cursed. Codex is available as an experimental second adapter. To wire in a new CLI (openrouter, gemini-cli, …) see [`docs/adapters.md`](./docs/adapters.md).

## Development

### Loading the plugin

Two modes depending on what you're doing:

**Per-session (live working tree — best for active development):**

```bash
claude --plugin-dir /path/to/cursed
```

Changes to your working tree are picked up immediately on the next Claude Code restart. No install step needed. The testbed uses this mode automatically when you pass `pluginDir` to `lib.start()`.

**Persistent local install (tests the full install flow):**

Claude Code's plugin system installs from marketplaces. To register your local checkout as a marketplace and install from it:

```bash
# 1. Create a local marketplace directory with a symlink to this repo
mkdir -p ~/.claude/local-marketplace/.claude-plugin
mkdir -p ~/.claude/local-marketplace/plugins
ln -sfn /path/to/cursed ~/.claude/local-marketplace/plugins/cursed

cat > ~/.claude/local-marketplace/.claude-plugin/marketplace.json << 'EOF'
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "cursed-local",
  "description": "Local development plugins",
  "owner": { "name": "your name" },
  "plugins": [
    {
      "name": "cursed",
      "description": "Multi-model code review, delegation, and advice via Cursor CLI",
      "author": { "name": "your name" },
      "source": "./plugins/cursed"
    }
  ]
}
EOF

# 2. Register the marketplace and install
claude plugin marketplace add ~/.claude/local-marketplace --scope local
claude plugin install cursed@cursed-local --scope local
```

Restart Claude Code. The plugin installs from a snapshot of your working tree — to pick up subsequent changes, reinstall:

```bash
claude plugin uninstall cursed@cursed-local --scope local
claude plugin install cursed@cursed-local --scope local
```

### Quality gates

```bash
npm run typecheck      # tsc as JSDoc checker (no build output)
npm run lint           # biome lint
npm run format:check   # biome format --check
npm run format         # biome format --write
npm test               # unit + smoke
npm run test:unit      # unit only
npm run test:smoke     # smoke only
npm run test:e2e       # real model calls (requires TESTBED_E2E=1 + Claude auth)
```

CI runs `typecheck`, `lint`, `format:check`, and `test` on every push and PR.

### Testbed

[`claude-code-testbed`](https://github.com/roiperlman/claude-code-testbed) is the developer harness for driving real Claude Code sessions programmatically — useful for iterating on plugin behavior (skill auto-trigger, MCP notification rendering, JSONL transcript shape) without manually opening a fresh window each round.

```bash
# Start a session with this repo's plugin loaded
SID=$(npm run --silent testbed -- start --plugin-dir . --no-bare)

npm run testbed -- send "$SID" "I want adversarial review of my diff."
npm run testbed -- wait-idle "$SID"
npm run testbed -- events "$SID" --format pretty
npm run testbed -- kill "$SID"
```

See [`docs/testbed.md`](./docs/testbed.md) for full usage. The e2e tests (`TESTBED_E2E=1 npm run test:e2e`) make real model calls — Haiku costs ~$0.0005/run. Do not add these to CI without a budget guard.

## Roadmap

- [x] **v0.1** — solo-mode MVP: four commands, watchdog timeouts, JSONL transcripts
- [x] **v0.2** — MCP-native panel mode, 3-model default for `review`, diversity-aware model selection
- [x] **v0.3** — `delegate --worktree`, `delegate --background`, background job management, pluggable adapter layer (Cursor + Codex), testbed harness
- [ ] **v0.4** — runtime model discovery, `/cursed:usage` cost reporting, budget warnings

## Skills

- **`using-cursed`** — autonomous-discovery skill that teaches Claude how to route tasks through cursed without explicit instruction. Auto-loads in fresh sessions. See [`skills/using-cursed/SKILL.md`](skills/using-cursed/SKILL.md).

## Contributing

Issues and PRs are welcome.

- **Bugs / questions:** open an issue.
- **Non-trivial changes:** open an issue first to agree on direction before writing code.
- **New adapters:** see [`docs/adapters.md`](./docs/adapters.md) for the contract and the steps to add one.
- **Gates:** every PR must pass `typecheck`, `lint`, `format:check`, and `test` locally before review.

## License

MIT. See [LICENSE](LICENSE).

---
description: Probe all CLI adapters (cursor-agent, codex) for installation and auth; print structured JSON status.
---

Ask the `cursed-worker` subagent to run the setup probe.

The subagent calls `mcp__plugin_cursed_cursed__setup` and returns an `AllAdaptersSetupResult`:
a JSON object keyed by adapter name (`cursor`, `codex`), each value a `SetupResult` with
`available`, `authenticated`, `version`, and `errors` fields.

Print the JSON verbatim. Then for each adapter, summarize its status:

- `available: false` → CLI not installed. Install instructions:
  - `cursor`: https://cursor.com/downloads (look for the CLI/agent install option)
  - `codex`: https://openai.com/codex (desktop app includes the CLI; `codex` binary is inside `Codex.app/Contents/Resources/`)
- `available: true, authenticated: false` → CLI installed but not authenticated:
  - `cursor`: set `CURSOR_API_KEY` or run `cursor login`
  - `codex`: set `OPENAI_API_KEY` or run `codex login`
- `available: true, authenticated: true` → ready

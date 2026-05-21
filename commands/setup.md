---
description: Probe CLI adapters, then walk through configuration and write config.toml.
---

Run the cursed setup configurator. This is interactive — ask the user questions and write their answers to `config.toml`.

## Step 1 — Probe

Call `mcp__plugin_cursed_cursed__setup`. It returns an `AllAdaptersSetupResult`: a JSON object keyed by adapter name (`cursor`, `codex`, `gemini`), each with `available`, `authenticated`, `version`, `errors`.

Print a one-line status per adapter. For any not ready:

- `available: false` → CLI not installed:
  - `cursor`: https://cursor.com/downloads
  - `codex`: https://openai.com/codex (the `codex` binary ships inside `Codex.app/Contents/Resources/`)
  - `gemini`: https://github.com/google-gemini/gemini-cli
- `available: true, authenticated: false`:
  - `cursor`: set `CURSOR_API_KEY` or run `cursor login`
  - `codex`: set `OPENAI_API_KEY` or run `codex login`
  - `gemini`: run `gemini` once to complete OAuth, or set `GEMINI_API_KEY`

If **no** adapter is available + authenticated, stop here — print the install guidance and do not continue to configuration.

## Step 2 — Load current config

Call `mcp__plugin_cursed_cursed__config_get`. It returns `{ config, path, exists, catalog: { tiers, vendors, adapters } }`. Use `config` values as the defaults in the questions below, and `catalog` for the available choices.

## Step 3 — Ask the core questions

Use `AskUserQuestion`. Pre-select defaults from the loaded config.

1. **Enabled adapters** (multi-select) — which adapters cursed may use. Pre-check the ones that probed as available + authenticated. If the user enables an adapter that is not available, warn them it will be skipped at runtime.
2. **Default adapter** (single-select, from the enabled set) — used for solo dispatch.
3. **Default panel tier** — one of the `catalog.tiers` (typically `fast`, `balanced`, `reasoning`).
4. **Vendor filter** (optional) — restrict panels to specific `catalog.vendors`, or "all vendors."

## Step 4 — Offer the advanced round

Ask once whether the user wants to set advanced options. If they decline, skip to Step 5. If they accept, ask:

- Per-command silence/total timeouts.
- Per-command panel sizes.
- `delegate.dirty_tree` — `refuse`, `warn`, or `allow`.

## Step 5 — Apply

Build a structured partial config object containing only the keys the user changed:

- `adapters.default`, `adapters.enabled`
- `panel.tier`, `panel.vendors`
- any advanced overrides under `commands.*`, `panel.commands.*`, `delegate.*`

Call `mcp__plugin_cursed_cursed__config_apply` with `{ config: <partial> }`. It validates, writes `config.toml`, and returns `{ ok, path, config, warnings }`.

Print the resolved `path`, a short summary of what was written, and every entry in `warnings` verbatim. Tell the user they can re-run `/cursed:setup` any time to change settings.

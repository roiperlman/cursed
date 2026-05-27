---
name: using-cursed
description: Use when you face a decision point you can't resolve with the code in front of you, when you want adversarial review of a diff before merging, or when you need a scoped task done by a model with different priors than yours. The cursed:cursed-worker subagent wraps non-Claude advisor and reviewer models (Cursor backend — Anthropic, OpenAI, Google, xAI). Each call costs real tokens and 10–60s; use sparingly.
---

# Using cursed

You have access to a **`cursed:cursed-worker`** subagent that wraps non-Claude reviewer/advisor models. Use the exact namespaced id `cursed:cursed-worker` when calling the Agent tool — the agent is registered under the plugin namespace, so the bare `cursed-worker` will not resolve. It is the entry point for the four `cursed` commands:

- `advise` — open question to a single non-Claude model when you're stuck on a decision.
- `review` — adversarial review of a diff. Defaults to a 3-model panel of one model per provider.
- `review-plan` — verify a written plan against the code it claims to modify.
- `delegate` — hand a bounded, well-specified task to one non-Claude model. Writes apply to the current tree (no isolation in v0.2).

## When to dispatch

Dispatch via the Agent tool with `subagent_type: "cursed:cursed-worker"` when:

- **Decision point:** you've evaluated the options and can't justify one over the other from the code alone. Ask the worker to call `advise`. Don't dispatch for routine choices.
- **Pre-merge review:** you're about to commit non-trivial changes (≥ ~100 LOC, or any code touching auth, migrations, concurrency, or money). Ask the worker to call `review`.
- **Plan verification:** you have an implementation plan that depends on assumptions about existing code. Ask the worker to call `review-plan` to catch outdated references and missing edges.
- **Scoped delegation:** there's a self-contained task another model could do without your context. Ask the worker to call `delegate`. Be specific about scope; the model writes to your working tree.

## How to dispatch

The subagent handles tier selection, panel sizing, and model resolution. Pass the user's intent in plain language; let the subagent decide the parameters. Do **not** call `mcp__plugin_cursed_cursed__*` tools directly — they're a private API the subagent owns.

Example:

> Dispatch to `cursed:cursed-worker`: "Review the diff `main...HEAD` — we're adding a payment-retry path with a new database table; flag concurrency risks."

## When NOT to dispatch

- Tasks you can resolve by reading the code yourself. The wall-clock cost (10–60s) and token cost are real.
- Anything that needs deep, persistent context about *this* conversation. The subagent's prompt is bounded; it doesn't see your reasoning history.
- Continuous loops or polling. Each call is a one-shot.

## What you'll get back

For solo runs (`advise`, `delegate`, `review-plan` by default): a `SoloRunResult` JSON with a single `run` object containing `text`, `files_changed`, `tokens`, `transcript_path`.

For panel runs (`review` by default; `review-plan` opt-in): a `PanelResult` JSON with `runs` (length 1–3), `summary`, `transcript_aggregate_path`. **You synthesize** — present the per-model findings to the user, call out divergences, do not collapse to a single voice. The wrapper deliberately does no synthesis (cursed-design.md §11.5).

## Setup

If `mcp__plugin_cursed_cursed__setup` reports `available: false` or `authenticated: false`, surface the error to the user and link them to the Cursor CLI install / `cursor login` docs. Do not attempt remediation yourself.

---
description: Get adversarial code review from non-Claude models. v0.2: 3-model panel by default; --solo for one model.
---

Ask the `cursed:cursed-worker` subagent to forward this review request. (The agent is plugin-namespaced — use the exact id `cursed:cursed-worker` with the Agent tool.)

Usage:
  /cursed:review                              # 3-model panel of current branch vs main
  /cursed:review <path>                       # review a specific path
  /cursed:review --target <git-ref>           # review a specific diff range
  /cursed:review --solo                       # one model only
  /cursed:review --panel <1|2|3>              # set panel size explicitly
  /cursed:review --models <m1,m2>             # pin specific models (panel size = list length)
  /cursed:review --diversity false            # disable provider-distribution selection
  /cursed:review --include-untracked          # also include untracked files in the bundle (respects .gitignore)

`--include-untracked` is opt-in. Reviewers can only flag what they can see, so
new files (tests, license headers, docs) are otherwise skipped. The flag lists
untracked paths via `git ls-files --others --exclude-standard`, so anything in
`.gitignore` (local scratch, generated artifacts) stays out of the bundle.

Dispatch to `cursed:cursed-worker` with the user's arguments. Present the result:

**If `result.panel === false` (SoloRunResult):**
- If `run.status === "completed"`: print `run.text` (the review findings), then a footer: model used, duration, token totals.
- If `run.status === "failed"`: print `run.error.code` + `run.error.message`, mention `run.transcript_path`.

**If `result.panel === true` (PanelResult):**
- Start with a one-line adapter-grouped summary derived from `runs[].adapter` — e.g. `By adapter: 2/3 cursor-routed (claude-4.6, gpt-5.4); 1/3 antigravity-routed (gemini-2.7)`. This is the convergence/divergence signal grouped by provider routing and lets the reader notice patterns like "two cursor-routed models agree; antigravity diverges."
- Show each model's findings as a **separate section** with the model name as a heading, followed by a `[adapter]` tag (e.g. `### claude-4.6 [cursor]`). Tag values come from `RunRecord.adapter`; omit the tag when adapter is missing or unknown. Do not merge or paraphrase across models.
- Where models converge on the same finding, note the convergence after the per-model sections — this is signal.
- Where models diverge, present both/all positions; let the user judge. **Do not collapse divergences to your own opinion.**
- If `summary.models_failed > 0`, note which models failed and why (`summary.errors[].code`), but do not retry.
- Footer: `summary.models_completed`/total, total duration, total tokens, link to `transcript_aggregate_path`.

The wrapper deliberately does no synthesis of findings (master design §11.5). Synthesis is your job; signal lives in the divergence. Adapter grouping is a structural label, not a content synthesis — it's safe to emit.

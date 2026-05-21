---
description: Get adversarial code review from non-Claude models. v0.2: 3-model panel by default; --solo for one model.
---

Ask the `cursed-worker` subagent to forward this review request.

Usage:
  /cursed:review                              # 3-model panel of current branch vs main
  /cursed:review <path>                       # review a specific path
  /cursed:review --target <git-ref>           # review a specific diff range
  /cursed:review --solo                       # one model only
  /cursed:review --panel <1|2|3>              # set panel size explicitly
  /cursed:review --models <m1,m2>             # pin specific models (panel size = list length)
  /cursed:review --diversity false            # disable provider-distribution selection

Dispatch to `cursed-worker` with the user's arguments. Present the result:

**If `result.panel === false` (SoloRunResult):**
- If `run.status === "completed"`: print `run.text` (the review findings), then a footer: model used, duration, token totals.
- If `run.status === "failed"`: print `run.error.code` + `run.error.message`, mention `run.transcript_path`.

**If `result.panel === true` (PanelResult):**
- Show each model's findings as a **separate section** with the model name as a heading. Do not merge or paraphrase across models.
- Where models converge on the same finding, note the convergence after the per-model sections — this is signal.
- Where models diverge, present both/all positions; let the user judge. **Do not collapse divergences to your own opinion.**
- If `summary.models_failed > 0`, note which models failed and why (`summary.errors[].code`), but do not retry.
- Footer: `summary.models_completed`/total, total duration, total tokens, link to `transcript_aggregate_path`.

The wrapper deliberately does no synthesis (master design §11.5). Synthesis is your job; signal lives in the divergence.

---
description: Verify a plan against the code it claims to modify. Catches outdated assumptions, missing edges, sequencing bugs.
---

Ask the `cursed-worker` subagent to forward this plan-review request.

Usage:
  /cursed:plan-review <plan-file>                  # solo (default)
  /cursed:plan-review <plan-file> --panel 2|3      # panel mode
  /cursed:plan-review <plan-file> --models <m1>    # pin model

Dispatch to `cursed-worker`. Present the result:

- **SoloRunResult (`panel: false`):** if `run.status === "completed"`, print `run.text` (the verification findings); else print error + transcript path.
- **PanelResult (`panel: true`):** present each model's findings under a separate heading. Where models agree on a missing edge or outdated assumption, that's a strong signal — flag it. Where they disagree, present both. Footer with `summary` totals.

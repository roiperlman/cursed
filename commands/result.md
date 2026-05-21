---
description: Harvest the full SoloRunResult of a terminal background `delegate` job.
argument-hint: "<id>"
---

Print the result for the named job. Errors clearly if the job is still running.

Require exactly one positional argument (the job id). If absent, link to `/cursed:status`.

Execute exactly one Bash call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursed.mjs" jobs result $ARGUMENTS --json
```

If the command exits non-zero with "still running", the job has not finished — tell the user to check `/cursed:status <id>` or run `/cursed:cancel <id>`.

Otherwise, the output is a full SoloRunResult JSON. Render it as the foreground `delegate` result is rendered — summarize `run.text`, surface `worktree.followup_commands`, and call out `run.warnings` if non-empty.

---
description: Cancel a running background `delegate` job. Synchronous, up to 10s.
argument-hint: "<id>"
---

Cancel the named job.

Require exactly one positional argument (the job id). If the user did not pass one, tell them so and link to `/cursed:status`.

Execute exactly one Bash call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursed.mjs" jobs cancel $ARGUMENTS
```

The call may take up to ~10 seconds while the worker shuts down. Return the JSON output verbatim:
- If the result includes `run.status` (terminal), the job stopped within the budget; surface its `exit_reason` and `error.message` if failed.
- If the result includes `cancel_requested: true` with a hint, the budget expired; tell the user to re-check with `/cursed:status <id>`.

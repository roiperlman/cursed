---
description: List background `delegate` jobs in this workspace, or show one job's status.
argument-hint: "[<id>]"
---

Run the cursed jobs status command and report what it returns.

If the user passed a positional argument (a job id), include it; otherwise list all jobs.

Execute exactly one Bash call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursed.mjs" jobs status $ARGUMENTS
```

If the output is empty or says "no jobs", tell the user there are no background jobs in this workspace.

Otherwise, return the table verbatim. Do not summarize; the user is scanning for ids and statuses.

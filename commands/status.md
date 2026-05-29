---
description: List background `delegate` jobs and in-flight MCP runs (review/advise/plan-review) in this workspace, or show one job's detailed status.
argument-hint: "[<id>]"
---

Run the cursed jobs status command and report what it returns.

If the user passed a positional argument (a job id), include it; otherwise list everything.

Execute exactly one Bash call:

```
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/cursed.mjs" jobs status $ARGUMENTS
```

The command returns two sections when there's anything to show:

- **active MCP runs** — synchronous review/advise/plan-review/delegate runs currently executing inside the MCP server (one row per model; panels show one row per panel member).
- **background delegate jobs** — long-running `cursed:delegate --background` jobs that have their own worker process and worktree.

If the output says "no jobs or active runs", tell the user the workspace is idle. Otherwise, return the table(s) verbatim. Do not summarize; the user is scanning for ids, models, and statuses.

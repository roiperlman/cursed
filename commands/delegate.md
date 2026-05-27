---
description: Hand a bounded, well-specified task to a non-Claude model. Writes to your current tree by default; pass `--worktree <name>` to isolate the run in a fresh git worktree. Solo-only.
---

Ask the `cursed:cursed-worker` subagent to forward this delegate request. (The agent is plugin-namespaced — use the exact id `cursed:cursed-worker` with the Agent tool.)

**Safety:** by default, `delegate` refuses to run when `git status --porcelain`
reports uncommitted changes. Stash, commit, use `--worktree`, or pass
`--allow-dirty` to override per-call. Configure the policy globally in
`config.toml`:

```toml
[delegate]
dirty_tree = "refuse"   # default — block on dirty tree
# dirty_tree = "warn"   # proceed but emit a warning
# dirty_tree = "allow"  # proceed silently
```

Usage:
  /cursed:delegate "<task text>"
  /cursed:delegate "<task text>" --models <model>
  /cursed:delegate "<task text>" --worktree <name> [--base <ref>] [--keep]
  /cursed:delegate "<task text>" --allow-dirty
  # --panel is rejected (delegate is solo-only)

## Worktree isolation

`/cursed:delegate "<task>" --worktree feat-x` runs the task in
`.cursed/worktrees/feat-x/` on a fresh branch `feat-x` forked from `HEAD`
(override with `--base <ref>`). On success, the working directory is
auto-removed; the branch is retained for inspection (`git diff feat-x`,
`git merge feat-x`). Add `--keep` to preserve the working directory too. On
any failure, both branch and working directory are preserved. First
worktree run will append `.cursed/` to your `.gitignore` if absent.

Dispatch to `cursed:cursed-worker`. The result is a SoloRunResult:

- If `run.status === "completed"`: print `run.text` (the delegate prompt asks for 4 sections — files changed, what the change does, validation run, notes), then `run.files_changed` as a separate summary list.
- If `run.status === "failed"`: print error + remediation; recommend `git status` to see partial changes.
- If `worktree` is non-null: print `worktree.followup_commands` so the user can review/merge/clean up.

## Background mode (long-running tasks)

Pass `--background` alongside `--worktree` to detach the run:

```
/cursed:delegate "refactor module X end-to-end" --worktree refactor-x --background
```

The MCP call returns immediately with a job handle. The worker runs in the background, writing its full `SoloRunResult` to disk when finished. Track it with:

- `/cursed:status` — list all background jobs in this workspace
- `/cursed:status <id>` — detail for one job
- `/cursed:cancel <id>` — synchronous stop (SIGTERM, 5s grace, SIGKILL)
- `/cursed:result <id>` — fetch the final `SoloRunResult` once terminal

**Caveats:**

- `--background` **requires** `--worktree` — there is no in-place backgrounding. The job id, worktree name, and branch name are all the same string.
- Background jobs survive Claude Code restarts (they're detached processes; cursed only owns the on-disk state). If you close Claude Code mid-job, the run continues; you can attach back with `/cursed:status` in the next session.
- A job that exceeds `total_timeout_seconds + 60s` is reported as `stale` by `/cursed:status` (the worker is presumed dead). Worktree is retained for forensics.
- Job dirs are GC'd after `[delegate.background].retention_days` (default 7 days). Worktrees and branches are never GC'd by cursed — manage them with the standard `git worktree remove` / `git branch -d` commands surfaced in `worktree.followup_commands`.

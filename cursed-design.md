# cursed — design document

**Version:** 0.1 (design draft)
**Status:** Pre-implementation

A Claude Code plugin that wraps the Cursor CLI (`cursor-agent`) behind four opinionated commands: `review`, `plan-review`, `delegate`, `advise`. Multi-model panels by default for critique tasks, single-model for work and advice. Parent Claude synthesizes panel results.

---

## 1. Overview

### 1.1 What this is

`cursed` is a Claude Code plugin that lets the main Claude session hand narrow, well-shaped tasks to the Cursor CLI for execution by other models. It is **not** a generic Cursor wrapper. It exposes exactly four commands, each with a baked-in prompt stance, appropriate write/read posture, and a policy on how many models should run in parallel.

### 1.2 Who it is for

- Claude Code users who want a **second, critical perspective** on code, plans, or decisions — delivered by models other than Claude.
- Teams running multi-model workflows (open-cloche) who want harness diversity without installing and maintaining one CLI per model provider.

### 1.3 Why build it

- **Multi-model panels catch different bugs.** Three adversarial reviewers with different training runs, different scaffolding, and different provider priors converge on real issues and diverge on noise. That signal is the primary product.
- **Harness diversity is a debugging lever.** Sometimes the stuck thing isn't the model, it's Claude Code's scaffolding. A different harness on a different model sometimes succeeds where the native path fails.
- **Cursor CLI is already a router.** It speaks to OpenAI, Anthropic, Google, xAI, and more. One CLI covers the long tail of models without per-provider plumbing.

### 1.4 What this is not

- **Not a replacement for `codex:rescue`.** Codex is narrower (OpenAI-only) and more mature. `cursed` complements it; it does not supersede it.
- **Not an orchestrator-level runner in v0.2.** Running entire open-cloche workflow tasks as Cursor agents is Phase 3, out of scope for initial release.
- **Not a generic CLI.** No "run any Cursor command" escape hatch. The four commands are the surface.

---

## 2. Non-goals

Explicit non-goals so scope stays tight:

1. **No codex-style review gate** (stop-time blocker). Our `review` is user-invoked, not hook-triggered.
2. **No app-server broker architecture.** Codex has a long-running broker because it wraps OpenAI's server protocol. Cursor CLI is stateless enough that a request-scoped subprocess is sufficient.
3. **No custom retry/backoff on transient failures.** `cursor-agent` handles backend flakiness internally. Wrapping that just adds surprise.
4. **No TUI.** If browsing runs becomes necessary, the oc `awctl` CLI is the right home for it.
5. **No model registry we host.** Discovery happens through `cursor-agent` itself, with a static bundled fallback.
6. **No auto-synthesis by a 4th LLM.** Parent Claude synthesizes panel results. Adding a synthesizer call re-introduces the bandwagon problem we're designing against.
7. **No cross-plugin dependencies.** Does not depend on `codex`, `gsd`, or any specific plugin being installed. Can coexist with all of them.

---

## 3. Value proposition (honest)

### 3.1 What users gain

- **Multi-model access via one install.** `cursor-agent` routes to GPT, Claude, Gemini, Grok, and more. Users don't install and configure one CLI per provider.
- **Panel review mode.** Three adversarial reviewers running in parallel produce a structured consensus/divergence map. This is the feature that justifies the plugin existing.
- **Harness diversity.** A genuinely different scaffolding for cases where the bug is in the harness, not the model.
- **Opinionated prompts.** Each command ships with a battle-shaped prompt stance. Users don't re-invent "be adversarial, not a cheerleader" every time.

### 3.2 What doesn't matter (but sounds like it might)

- **Cursor IDE features** (Agents Window, Design Mode). Those are IDE/UI features; the CLI doesn't expose them.
- **Replacing Codex.** If the task is "OpenAI second opinion," `codex:rescue` is more mature. `cursed` is the choice when you want a *different* provider or a *panel*.
- **Cost savings.** Running three models in parallel costs ~3× a single call. Panel mode is a quality-of-signal play, not a cost play.

### 3.3 When to use vs. when not to

| Use `cursed` when... | Don't use when... |
|---|---|
| Reviewing a risky change and you want diverse critical voices | You trust the change and just want a sanity check (use Claude directly) |
| A plan/spec needs verification against real code | You're still drafting the plan (write it first) |
| Claude is stuck on a decision and a non-Claude advisor would help | The decision is routine and Claude can handle it |
| Small scoped task to hand off while Claude focuses elsewhere | The task is substantial — keep it in-thread for context |

---

## 4. High-level architecture

### 4.1 Request flow

```
User types: /cursed:review <target>
    │
    ▼
commands/review.md (slash command frontmatter + dispatch)
    │ reads user args
    ▼
Agent tool → agents/cursed-worker.md (subagent)
    │ reads task, inspects scope (git diff --stat, etc.)
    │ decides: tier=balanced, count=2, diverse=true
    ▼
Bash: node scripts/cursed.mjs run --command review \
          --tier balanced --count 2 --diverse --target HEAD
    │
    ▼
scripts/cursed.mjs
    │ resolves tier → [gpt-5.4, claude-sonnet-4-6]
    │ loads prompts/review.md template
    │ substitutes {{SCOPE}}, {{GUIDANCE}}
    ▼
spawns N × cursor-agent -p --output-format stream-json ...
    │   each with: own watchdog, own stream parser,
    │   own transcript file, own session_id
    ▼
Promise.allSettled → PanelResult aggregated
    │
    ▼
stdout: structured JSON back to subagent
    │
    ▼
Subagent returns to parent Claude (verbatim)
    │
    ▼
Parent Claude synthesizes findings for user:
    - "Consensus (2/2): findings A, B"
    - "Divergence (1/2): finding C — only gpt-5.4 flagged"
    - "Errored: -"
```

### 4.2 Layers

| Layer | Responsibility |
|---|---|
| **Slash commands** (`commands/*.md`) | Parse user args, dispatch to subagent, handle inline execution flags (`--background`, etc.) |
| **Subagent** (`agents/cursed-worker.md`) | Inspect context, choose tier/count/diversity, build one `cursed.mjs` invocation. Forward stdout back. |
| **Runtime** (`scripts/cursed.mjs`) | Resolve models, spawn `cursor-agent`(s), parse stream-json, run watchdogs, persist transcripts, aggregate PanelResult, emit structured output. |
| **Prompts** (`prompts/*.md`) | The opinion. Templated markdown with `{{VARS}}`. Command → prompt is 1:1. |
| **Model catalog** (`models.default.json` + discovery cache) | Tier → model list, auto-discovered with static fallback. |
| **State** (`$CLAUDE_PLUGIN_DATA/state/<workspace>/`) | Per-workspace: last session_id per command, background jobs index, transcript archive. |

---

## 5. Plugin layout

```
cursed/
├── .claude-plugin/
│   └── plugin.json                         # Claude Code manifest
├── scripts/
│   ├── cursed.mjs                          # entry point
│   └── lib/
│       ├── cli.mjs                         # arg parsing, subcommand routing
│       ├── config.mjs                      # $CLAUDE_PLUGIN_DATA/config.toml loader
│       ├── models.mjs                      # tier → models, discovery, diversity
│       ├── cursor.mjs                      # cursor-agent invocation builder
│       ├── stream.mjs                      # NDJSON parser + event typing
│       ├── watchdog.mjs                    # silence + total timer + signal escalation
│       ├── panel.mjs                       # Promise.allSettled orchestration
│       ├── state.mjs                       # session/job state, workspace partitioning
│       ├── transcripts.mjs                 # write + retrieve run transcripts
│       ├── errors.mjs                      # structured error taxonomy
│       ├── oc.mjs                          # open-cloche env detection & aw CLI calls
│       ├── git.mjs                         # git helpers (diff-stat, rev-parse, worktree)
│       └── render.mjs                      # final output shaping for Claude
├── skills/
│   ├── cursed-runtime/SKILL.md             # internal, runtime contract
│   └── cursed-result-handling/SKILL.md     # internal, how to present output
├── agents/
│   └── cursed-worker.md                    # the one subagent
├── commands/
│   ├── setup.md                            # /cursed:setup
│   ├── review.md                           # /cursed:review
│   ├── plan-review.md                      # /cursed:plan-review
│   ├── delegate.md                         # /cursed:delegate
│   ├── advise.md                           # /cursed:advise
│   ├── status.md                           # /cursed:status
│   ├── result.md                           # /cursed:result
│   ├── cancel.md                           # /cursed:cancel
│   └── usage.md                            # /cursed:usage
├── prompts/
│   ├── review.md
│   ├── plan-review.md
│   ├── delegate.md
│   └── advise.md
├── models.default.json                     # bundled fallback catalog
├── test/
│   ├── fixtures/
│   │   ├── stream-json/                    # recorded cursor-agent streams
│   │   └── config/                         # sample configs
│   ├── unit/
│   │   ├── stream.test.mjs
│   │   ├── watchdog.test.mjs
│   │   ├── panel.test.mjs
│   │   ├── models.test.mjs
│   │   └── errors.test.mjs
│   └── smoke/
│       └── setup.test.mjs                  # only `cursor-agent --version`
├── package.json                            # dev deps: vitest, eslint; no runtime deps
├── README.md
├── LICENSE
├── CHANGELOG.md
└── docs/
    ├── design.md                           # this file
    ├── architecture.md                     # deeper dive, post-v0.1
    ├── prompts.md                          # explanation of each command's stance
    └── oc-integration.md                   # open-cloche-specific guide
```

### 5.1 `plugin.json`

```json
{
  "name": "cursed",
  "version": "0.1.0",
  "description": "Multi-model panel review, plan verification, delegation, and advisory through Cursor CLI. Unofficial community tool. Not affiliated with Anthropic or Anysphere.",
  "author": {
    "name": "Roi Perlman"
  }
}
```

### 5.2 Trademark disclaimers

README must carry:

> **Unofficial community tool.** This project is not affiliated with, endorsed by, or sponsored by Anthropic, PBC or Anysphere, Inc. "Claude" is a trademark of Anthropic. "Cursor" is a trademark of Anysphere.

---

## 6. The four commands

Each command has three things: a **user-facing surface**, a **prompt stance** baked into a template, and **defaults** for tier/count/writes that the subagent can override based on task context.

### 6.1 `/cursed:review` — adversarial review

**Purpose.** An independent critical voice on code — typically a diff, a set of paths, or a PR branch. The stance is "find problems, not validate."

**Default policy:**
- **Tier:** `balanced`
- **Count:** 2 (small diffs) to 3 (large/risky diffs) — subagent decides
- **Diverse providers:** yes
- **Writes:** no
- **Silence timeout:** 120s / **Total timeout:** 1200s

**Args:**
```
/cursed:review                       # default: current branch diff vs main
/cursed:review <path>                # review a specific path
/cursed:review --target <git-ref>    # review a specific diff range
/cursed:review --solo                # force single model
/cursed:review --panel               # force panel even if subagent would pick solo
/cursed:review --models <list>       # explicit model list, overrides tier+count
```

**Prompt template** (`prompts/review.md`):

```markdown
You are an adversarial code reviewer. Another agent produced this work;
your job is to find problems, not validate.

Ground rules:
- Do not default to agreement. If the change is wrong, say so directly.
- If nothing is wrong, say so explicitly — do not invent issues to seem useful.
- Do not rewrite the code or propose replacements.
- Focus on: correctness, hidden assumptions, edge cases, security,
  operational failure modes, unchecked invariants.
- Each finding, structured:
    - location: specific file:line or function
    - problem: what is wrong
    - consequence: what breaks as a result
    - confidence: high | medium | low
- No softening phrases ("you might want to consider", "it could be worth").
  Either flag a problem or don't.
- If you disagree with the change's premise, say so first and separately
  from line-level findings.

Scope under review: {{SCOPE}}

Repository conventions (if relevant): {{REPO_GUIDANCE}}
```

**Example flow:**

1. User types `/cursed:review`.
2. Subagent runs `git diff main...HEAD --stat` → 340 LOC across `open_cloche/services/agent_spawner.py`.
3. Subagent decides: medium diff, shared infra → `--count 2 --tier balanced --diverse`.
4. `cursed.mjs` resolves models to `[gpt-5.4, claude-sonnet-4-6]`.
5. Two `cursor-agent` subprocesses spawn with the review prompt + scope = diff.
6. PanelResult returns with two structured findings sets.
7. Parent Claude presents:
   - `Consensus (2/2): race condition in _spawn_tmux at line 142`
   - `Consensus (2/2): missing timeout on .wait() call`
   - `Divergence (1/2): gpt-5.4 flagged potential file-descriptor leak; sonnet disagrees`

---

### 6.2 `/cursed:plan-review` — plan vs. code verification

**Purpose.** Verify a plan/spec document against the actual code it claims to change. Catch outdated assumptions, missing edge cases, unjustified abstractions, sequencing bugs.

**Default policy:**
- **Tier:** `reasoning`
- **Count:** 2 (standard) to 1 (short plans) — subagent decides
- **Diverse providers:** yes
- **Writes:** no
- **Silence timeout:** 180s / **Total timeout:** 1800s

**Args:**
```
/cursed:plan-review <plan-file>
/cursed:plan-review <plan-file> --solo
/cursed:plan-review <plan-file> --models <list>
```

**Prompt template** (`prompts/plan-review.md`):

```markdown
You are reviewing a plan against the actual code it claims to modify.
The plan may be wrong about the code, wrong about the approach, or both.

For every claim the plan makes about existing behavior:
- verify by reading the code
- note any claim that does not match reality
- cite the specific file:line you checked

For every proposed change, identify concrete failure modes:
- wrong assumptions (about APIs, data shapes, invariants)
- missing edge cases
- unjustified abstractions or scope creep
- sequencing bugs (step A assumes step B already done, but step B is later)
- implicit migrations without a plan
- breaking changes to callers not listed

Do not rewrite the plan. Do not propose a better plan. Your only job is
to enumerate problems with the plan as written.

If the plan is sound, say so — and list the specific verifications you ran
to reach that conclusion.

Plan file: {{PLAN_PATH}}
Referenced code paths: {{CODE_PATHS}}
```

---

### 6.3 `/cursed:delegate` — scoped task handoff

**Purpose.** Hand a bounded, well-specified task to Cursor. Minimal change, no scope expansion, report back what happened.

**Default policy:**
- **Tier:** `balanced`
- **Count:** 1 (panel prohibited unless `--worktree`)
- **Writes:** yes (the only write-capable command)
- **Silence timeout:** 120s / **Total timeout:** 1800s

**Args:**
```
/cursed:delegate <task text>
/cursed:delegate <task text> --background         # fire-and-forget
/cursed:delegate <task text> --worktree <branch>  # isolated worktree
/cursed:delegate <task text> --models gpt-5.4     # pick model
/cursed:delegate <task text> --panel --worktree   # panel mode (worktrees required)
```

**Prompt template** (`prompts/delegate.md`):

```markdown
You are being handed a single scoped task. Execute it — do not expand
scope, do not refactor adjacent code, do not add tests that were not
requested.

Rules:
- Make the minimal change that satisfies the task.
- If the task is ambiguous, ask one clarifying question before
  proceeding. Do not guess and proceed.
- Respect existing file structure and naming conventions.
- Do not add dependencies without calling that out.
- Before finishing, verify the change by running whatever local
  validation the repo supports (tests, type-check, lint) if appropriate
  for the task.

When done, report exactly:
  1. Files changed (full paths)
  2. What the change does (one paragraph)
  3. What you ran to validate it (commands + exit codes)
  4. Anything you noticed but did not fix (list, or "none")

Task: {{TASK}}

Repository conventions: {{REPO_GUIDANCE}}
```

**Sandboxing.** `delegate` is the only write-capable command. The wrapper enforces:

1. **Pre-run snapshot.** `git rev-parse HEAD` + `git status --porcelain` captured.
2. **Dirty-tree policy** (config-driven):
   - `refuse` — abort if the working tree is dirty.
   - `warn` — print a warning, proceed.
   - `allow` — proceed silently (not recommended).
   - Default: `warn`.
3. **Post-run report.** Diff summary (`git diff --stat` against pre-run HEAD) included in the structured output.
4. **`--panel` requires `--worktree`.** Three models writing the same tree produces corrupt state. The wrapper refuses `--panel` without a worktree flag; with `--worktree <branch>`, each model gets its own worktree branched from a common base. The user compares three diffs afterward (likely with `/cursed:review` on each).

### 6.4 `/cursed:advise` — decision-point advisor

**Purpose.** The [Anthropic executor/advisor pattern](https://www.anthropic.com/research/building-effective-agents). Claude is the executor; it hits a decision it cannot resolve confidently; it calls `cursed:advise` with full context. The advisor returns exactly one of: a plan, a correction, or a stop signal.

**Default policy:**
- **Tier:** `reasoning`
- **Count:** 1 (solo is the right shape for decisive advice)
- **Writes:** no
- **Silence timeout:** 180s / **Total timeout:** 1800s

**Args:**
```
/cursed:advise <question text>
/cursed:advise <question text> --context-file <path>   # file with context to attach
/cursed:advise <question text> --panel                 # force panel (rare, for contentious calls)
```

**Prompt template** (`prompts/advise.md`):

```markdown
You are an advisor in an executor/advisor pattern. The executing agent
(another Claude) has stopped at a decision it cannot confidently resolve.
You have access to the shared context below.

Return exactly one of these three:

1. A concrete plan — specific steps the executor should take, in order.
   Include: what tools to invoke, what files to read or write, what the
   expected outcome is, and how to verify it worked.

2. A correction — a flawed assumption in the executor's reasoning,
   with what to replace it with. Point to the specific part of the
   context that is wrong.

3. A stop signal — a reason the executor should halt and report back to
   the human, including what information the human needs to decide.

Rules:
- Do not implement. Do not write code. Do not modify files.
- Be decisive. "It depends" is not a valid response — either give the
  condition under which each branch applies, or pick one.
- Reference the specific part of the context that informs your advice.
- If the decision point is ambiguous, return a stop signal, not a guess.

Decision point: {{QUESTION}}

Shared context: {{CONTEXT}}
```

**Context handover.** Default: user (or parent Claude) pastes the relevant snippet into the `--context-file` or inline as part of `<question text>`. The wrapper does not scrape transcripts.

---

## 7. Runtime contract (`cursed.mjs`)

### 7.1 Subcommands

| Subcommand | Purpose |
|---|---|
| `setup` | Probe `cursor-agent` installation + auth; print JSON status |
| `run` | Execute a command — solo or panel |
| `status [job-id]` | Report background job status |
| `result [job-id]` | Print final output of a background job |
| `cancel [job-id]` | Send SIGTERM (then SIGKILL) to a background job |
| `usage [--since <date>]` | Aggregate token/cost accounting |
| `discover-models [--force]` | Refresh model catalog from `cursor-agent` |

### 7.2 `run` flags

```
--command <review|plan-review|delegate|advise>    required
--prompt-template <path>                           default: inferred from command
--vars <json>                                      template substitutions
--tier <fast|balanced|reasoning>                   required (unless --models)
--count <1|2|3>                                    required (unless --models)
--diverse                                          prefer cross-provider selection
--models <comma-list>                              explicit list, overrides tier+count
--write                                            allow file writes (delegate only)
--background                                       fire-and-forget, return job-id
--silence-timeout <sec>                            default: from config per command
--total-timeout <sec>                              default: from config per command
--resume-last                                      resume prior session (solo only)
--worktree <branch>                                delegate: isolated worktree
--target <ref|path>                                review: what to review
```

### 7.3 Output format

All subcommands emit **structured JSON to stdout**. Human-readable rendering happens in the parent Claude, not the wrapper.

**`setup` output:**

```json
{
  "available": true,
  "version": "1.4.2",
  "authenticated": true,
  "default_model": "gpt-5.4",
  "providers_reachable": ["openai", "anthropic", "google"],
  "warnings": [],
  "errors": []
}
```

**`run` output (solo):**

```json
{
  "panel": false,
  "command": "delegate",
  "run": {
    "model": "claude-sonnet-4-6",
    "tier": "balanced",
    "status": "completed",
    "session_id": "cur_abc123",
    "text": "Done. Files changed: src/foo.py. ...",
    "files_changed": ["src/foo.py"],
    "commands_run": ["pytest tests/test_foo.py"],
    "tokens": {"input": 4200, "output": 1800, "cache_read": 800},
    "duration_ms": 42310,
    "transcript_path": "~/.claude/plugins/data/cursed/state/.../runs/2026-04-24/142301-delegate-claude-sonnet-4-6.jsonl",
    "exit_reason": "completed"
  },
  "selected_reason": "User forced solo via --solo flag",
  "oc_context": null
}
```

**`run` output (panel):**

```json
{
  "panel": true,
  "command": "review",
  "runs": [
    {"model": "gpt-5.4", "tier": "balanced", "status": "completed", ...},
    {"model": "claude-sonnet-4-6", "tier": "balanced", "status": "completed", ...},
    {"model": "gemini-3", "tier": "balanced", "status": "failed", "error": {"code": "stall", "message": "..."}}
  ],
  "summary": {
    "wall_duration_ms": 48100,
    "total_tokens": {"input": 12600, "output": 5400, "cache_read": 2400},
    "successful_runs": 2,
    "failed_runs": 1
  },
  "selected_reason": "Medium diff in shared infra; panel=2 balanced diverse (3rd model failed)",
  "oc_context": {"run_id": "...", "task_id": "...", "agent_id": "..."} 
}
```

### 7.4 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (at least one run completed) |
| 1 | All runs failed, no results |
| 2 | Configuration / argument error |
| 3 | Auth failure (no API key, invalid credentials) |
| 4 | `cursor-agent` not installed |

---

## 8. Stream-json parsing

### 8.1 Assumption

`cursor-agent -p --output-format stream-json` emits newline-delimited JSON events to stdout. Each line is one event object with a `type` field. Exact schema must be discovered empirically in v0.1 development — this doc documents the *expected* shape and flags this as an **open question** (§21).

### 8.2 Expected event types (discovery required)

| Type (expected) | Meaning |
|---|---|
| `assistant_message` | Final text from the model |
| `assistant_partial` | Streaming text fragment |
| `tool_call` | Model invoked a tool (file read/write, shell, search) |
| `tool_result` | Result of a tool call |
| `error` | Non-fatal error from the agent |
| `thinking` | Optional reasoning trace |
| `session_start` | Metadata: session_id, model, etc. |
| `session_end` | Final metadata: tokens, duration |

### 8.3 Parser responsibilities

`stream.mjs`:

1. Read stdout line-by-line (`readline.createInterface`).
2. Parse each line as JSON; tolerate parse errors (log + skip).
3. Categorize events into buckets:
   - `session` — metadata
   - `message` — text fragments to accumulate
   - `tool` — file-change / command-execution events
   - `error` — collected into final error list
4. Raise `event` to the watchdog on every parsed line (resets silence timer).
5. Accumulate **final assistant text** by concatenating `assistant_message` / completing `assistant_partial` streams.
6. Extract **files_changed** from `tool_call` events where `name` is `edit_file`, `write_file`, or equivalent (exact names TBD from discovery).
7. Extract **commands_run** from `tool_call` events where `name` is `shell` or equivalent.
8. On `session_end`, extract **tokens** and **duration**.

### 8.4 Parser output structure

```typescript
interface ParsedRun {
  session_id: string | null;
  model: string;
  text: string;
  files_changed: string[];
  commands_run: string[];
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  duration_ms: number;
  errors: { code: string; message: string }[];
  raw_event_count: number;  // for debugging
}
```

### 8.5 Fixture-based testing

Record real `cursor-agent` output into `test/fixtures/stream-json/*.jsonl` during v0.1 development. Parser tests read these fixtures and assert against expected `ParsedRun` outputs. This decouples parser correctness from Cursor backend availability in CI.

---

## 9. Watchdog design

### 9.1 State machine

```
         ┌──────────┐
         │   IDLE   │   (process not spawned yet)
         └─────┬────┘
               │ spawn()
               ▼
         ┌──────────┐
         │ RUNNING  │   (receiving events; silence timer resets each event)
         └─────┬────┘
               │
      ┌────────┼────────────┬──────────────┬──────────────┐
      │        │            │              │              │
      ▼        ▼            ▼              ▼              ▼
  session_   silence    total_timeout   error_event    SIGINT/
  end        timeout    exceeded        (fatal)        cancel
      │        │            │              │              │
      ▼        ▼            ▼              ▼              ▼
 COMPLETED STALLED     TIMED_OUT        FAILED        CANCELLED
      │        │            │              │              │
      └────────┴────────────┴──────────────┴──────────────┘
                            │
                            ▼
                  final cleanup + exit
```

### 9.2 Two timers

- **Silence timer**: N seconds (default 120). Resets on every parsed stream-json event. If it fires, transition `RUNNING → STALLED`.
- **Total timer**: N seconds (default 1200 for review/plan-review/delegate, 1800 for advise). Starts at spawn. Does not reset. If it fires, transition to `TIMED_OUT`.

Both timers are independent. Whichever fires first wins.

### 9.3 Kill escalation

When transitioning to a terminal state due to timer fire:

1. Send `SIGTERM` to the `cursor-agent` subprocess.
2. Wait 5 seconds for graceful exit.
3. If still running, send `SIGKILL`.
4. Always collect partial output that arrived before kill and include it in the result (status = `stalled` / `timed_out`).

### 9.4 The Cursor hang bug

Per known issue: `cursor-agent -p` [can hang indefinitely](https://forum.cursor.com/t/cursor-agent-p-print-headless-mode-hangs-indefinitely-and-never-returns/150246) without emitting events. The silence watchdog is the primary defense. A bare overall timeout is not enough — the silence timer ensures "no progress" is detected early, not after 20+ minutes.

---

## 10. Model selection

### 10.1 Tiers (stable semantic categories)

| Tier | Intent |
|---|---|
| `fast` | Cheap/small models. Quick iteration, simple tasks, low-risk reviews. |
| `balanced` | Mid-tier. Default for most reviews and delegate tasks. |
| `reasoning` | Top-tier reasoning models. Plans, hard advice, large or risky reviews. |

Tiers don't rot when model names change. A new `gpt-5.5` or `sonnet-4.7` slots into the same tier. `models.default.json` maps tier → list; discovery refreshes this from `cursor-agent` when possible.

### 10.2 Claude-side judgment (subagent heuristics)

The `cursed-worker` subagent picks `tier` and `count` at call-time based on task context. Heuristics live in the subagent markdown so they can be iterated on without touching the runtime.

**Baseline heuristics** (see §6 for full per-command defaults):

```
/cursed:review:
  - diff < 100 LOC, low-risk area:      count=1, tier=balanced
  - diff 100-500 LOC or shared infra:   count=2, tier=balanced, diverse
  - diff > 500 LOC, migrations,
    security-sensitive, concurrency:    count=3, tier=reasoning, diverse

/cursed:plan-review:
  - plan < 500 expected LOC change:     count=1, tier=reasoning
  - plan medium/large, or touches
    multiple subsystems:                count=2, tier=reasoning, diverse

/cursed:delegate:
  - always:                             count=1
  - tier = user-stated complexity
    (default: balanced; escalate to
    reasoning if task mentions
    architecture, migration, security)

/cursed:advise:
  - always:                             count=1, tier=reasoning
  - --panel override only if user
    explicitly asks ("get second
    opinions on this")
```

User explicit overrides (`--solo`, `--panel`, `--models`) always win over these defaults.

### 10.3 Discovery with static fallback

**Discovery path** (preferred):

1. `/cursed:setup` runs `cursor-agent models list --json` (or equivalent — exact invocation is an open question).
2. Parse output; categorize into tiers using name heuristics:
   - `*mini*`, `*haiku*`, `*flash*`, `*fast*` → `fast`
   - `*pro*`, `*opus*`, `*ultra*`, `*max*`, `*o1*`, `*o3*` → `reasoning`
   - otherwise → `balanced`
3. Write to `$CLAUDE_PLUGIN_DATA/models.json` with a TTL (7 days).
4. On every `run`, load from cache; if stale or missing, re-discover (non-blocking — use fallback while discovery runs).

**Static fallback** (if `cursor-agent` doesn't expose machine-readable listing):

`models.default.json` ships with the plugin and is updated on each release:

```json
{
  "version": "1.0",
  "updated_at": "2026-04-24",
  "tiers": {
    "fast": ["haiku-4-5", "gpt-5.4-mini", "gemini-3-flash"],
    "balanced": ["gpt-5.4", "claude-sonnet-4-6", "gemini-3"],
    "reasoning": ["gpt-5.4-pro", "claude-opus-4-7", "gemini-3-ultra", "grok-4"]
  },
  "providers": {
    "openai": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-pro"],
    "anthropic": ["haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"],
    "google": ["gemini-3-flash", "gemini-3", "gemini-3-ultra"],
    "xai": ["grok-4"]
  }
}
```

### 10.4 Diversity algorithm

When `--diverse` is set and `count > 1`, select one model per provider in round-robin order:

```javascript
function selectDiverse(catalog, tier, count) {
  const candidates = catalog.tiers[tier];
  const providers = groupByProvider(candidates, catalog.providers);
  // providers: { openai: [...], anthropic: [...], google: [...] }
  const selected = [];
  const providerList = Object.keys(providers);
  let i = 0;
  while (selected.length < count && providerList.length > 0) {
    const provider = providerList[i % providerList.length];
    if (providers[provider].length > 0) {
      selected.push(providers[provider].shift());
    } else {
      providerList.splice(i % providerList.length, 1);
      continue;
    }
    i++;
  }
  return selected;
}
```

Non-diverse: pick first `count` from the tier in catalog order.

### 10.5 User override precedence

```
--models <list>    (wins over everything below)
    ↓
env var AMICUS_FORCE_MODELS
    ↓
--tier/--count/--diverse from subagent
    ↓
config.toml per-command defaults
    ↓
built-in per-command defaults (§6)
```

---

## 11. Panel execution

### 11.1 Orchestration

`panel.mjs` runs up to N subprocesses concurrently using `Promise.allSettled`. Each run is fully independent:

```javascript
async function runPanel({ models, promptPath, vars, limits }) {
  const settled = await Promise.allSettled(
    models.map(model => runOne({ model, promptPath, vars, limits }))
  );
  return {
    panel: models.length > 1,
    runs: settled.map((s, i) => ({
      model: models[i],
      ...(s.status === 'fulfilled' ? s.value : { status: 'failed', error: s.reason })
    })),
    summary: aggregate(settled)
  };
}
```

### 11.2 Independence

Each run has:
- Its own subprocess (separate `cursor-agent` invocation)
- Its own silence + total watchdogs
- Its own stream-json parser
- Its own transcript file
- Its own session_id (for resume)

A stall or error in one run does not affect the others. All runs either complete or are cleanly killed before the orchestration returns.

### 11.3 Concurrency cap

Hard cap: `max_panel_size = 3` (configurable, ceiling is 3 by design). Attempting `--count 5` → clamped to 3 with a warning logged in the result.

### 11.4 Rate-limit handling

If `cursor-agent` returns a rate-limit error (backend signal — exact detection TBD from parser work):

- Mark that run as `failed` with `error.code = "rate_limited"`.
- Do **not** retry. Do **not** slow the others.
- Continue the panel; report the failure in the summary.

Users see: "2 of 3 reviewers completed; gemini-3 was rate-limited." Parent Claude decides whether partial panel is useful.

### 11.5 Synthesis is not done here

The wrapper **does not synthesize** panel results into a single output. It returns the structured PanelResult to the parent Claude, which synthesizes for the user. This is deliberate:

- Adding a 4th LLM call to synthesize re-introduces the bandwagon problem we're designing against (a synthesizer LLM pressured to find consensus).
- Parent Claude already has user context and can make better editorial judgments (what to highlight, what to de-emphasize).
- Keeps the wrapper stateless and composable.

Synthesis guidance lives in each command's markdown (see §6) so Claude knows how to present PanelResult to the user.

---

## 12. Configuration

### 12.1 Location

Follows Claude Code plugin convention: everything lives under `$CLAUDE_PLUGIN_DATA` (Claude Code-exported env var resolving to `~/.claude/plugins/data/cursed/`). Falls back to `$TMPDIR/cursed-plugin` if unset.

**No repo-root config file.** Per-project overrides go through env vars.

### 12.2 Layout

```
$CLAUDE_PLUGIN_DATA/
├── config.toml                           # user-level overrides (optional)
├── models.json                           # discovered catalog cache
└── state/
    └── <workspace-slug>-<sha256[:16]>/   # per-workspace partition
        ├── state.json                    # last session_ids, jobs index
        └── runs/
            └── 2026-04-24/
                ├── 142301-delegate-claude-sonnet-4-6.jsonl  # per-run transcript
                ├── 142301-delegate.panel.json                # aggregated panel result
                └── ...
```

Workspace-slug = `<basename>-<first 16 hex of sha256(canonical-cwd)>`. Matches codex's pattern exactly.

### 12.3 `config.toml` schema

All sections are optional. Defaults come from discovery + built-ins.

```toml
[defaults]
max_panel_size = 3
silence_timeout_seconds = 120
total_timeout_seconds = 1200

[budget]
warn_before_panel_tokens = 100000

[tiers]
# Optional overrides. Empty = use discovered catalog.
# fast = ["haiku-4-5"]
# balanced = ["gpt-5.4", "claude-sonnet-4-6", "gemini-3"]
# reasoning = ["gpt-5.4-pro", "claude-opus-4-7", "gemini-3-ultra"]

[commands.review]
# Per-command overrides, all optional
# tier = "balanced"
# count = 2
# diverse = true
# silence_timeout_seconds = 120

[commands.plan-review]
# tier = "reasoning"
# silence_timeout_seconds = 180

[commands.delegate]
# dirty_tree = "warn"   # refuse | warn | allow
# tier = "balanced"

[commands.advise]
# tier = "reasoning"
# silence_timeout_seconds = 180
```

### 12.4 Env var overrides

```
CURSED_DEBUG=1                          # verbose logging to stderr
CURSED_REVIEW_TIER=balanced             # override tier for review
CURSED_REVIEW_COUNT=1                   # override count for review
CURSED_FORCE_MODELS=gpt-5.4,sonnet-4.6  # override everything, force explicit models
CURSED_MAX_PANEL_SIZE=2                 # override cap
CURSED_DIRTY_TREE=refuse                # override delegate dirty-tree policy
CURSED_DISCOVERY_TTL_DAYS=7             # model cache TTL
```

Pattern: `CURSED_<UPPER_SNAKE>`. Command-specific vars use `CURSED_<COMMAND>_<SETTING>`.

### 12.5 Precedence

```
CLI flag  >  env var  >  config.toml  >  built-in default
```

---

## 13. State & persistence

### 13.1 Session resume

`cursor-agent` supports session resume by ID (exact mechanism TBD from discovery — expected flag: `--resume-session <id>` or similar).

State per workspace:

```json
{
  "version": 1,
  "last_sessions": {
    "review": "cur_abc123",
    "plan-review": "cur_def456",
    "delegate": "cur_ghi789",
    "advise": "cur_jkl012"
  },
  "jobs": [
    {
      "job_id": "bg_001",
      "command": "delegate",
      "model": "claude-sonnet-4-6",
      "pid": 12345,
      "started_at": "2026-04-24T14:23:01Z",
      "status": "running",
      "transcript_path": "..."
    }
  ]
}
```

Solo runs can be resumed via `--resume-last`. Panel runs are not resumable (three session IDs, ambiguous which to continue).

### 13.2 Transcripts

Every run, successful or failed, writes a full JSONL transcript:

```
$CLAUDE_PLUGIN_DATA/state/<workspace>/runs/<YYYY-MM-DD>/<HHMMSS>-<command>-<model>.jsonl
```

Panel runs also write an aggregated result:

```
$CLAUDE_PLUGIN_DATA/state/<workspace>/runs/<YYYY-MM-DD>/<HHMMSS>-<command>.panel.json
```

Transcripts are retained per a rolling policy:
- Default: 30 days.
- Configurable via `[defaults] transcript_retention_days`.
- Cleanup is lazy — runs on plugin startup if the last cleanup was > 24h ago.

### 13.3 Background jobs

`--background` flag on `delegate` (the only command where this makes sense) forks the subprocess and returns a `job_id`. `/cursed:status <job_id>`, `/cursed:result <job_id>`, `/cursed:cancel <job_id>` operate on these.

Background jobs are tracked in `state.json`. A crashed wrapper leaves orphan entries; startup runs a reconciliation pass (check if PID still alive; if not, mark job as `failed` with `error.code = "orphan"`).

---

## 14. Error taxonomy

Structured error codes appear in `run.error.code`. Claude-side rendering in command markdown knows how to react to each.

| Code | Meaning | Wrapper behavior | Claude-side suggestion |
|---|---|---|---|
| `auth_failed` | No API key, invalid credentials | Exit 3, structured error | Tell user to run `/cursed:setup` |
| `not_installed` | `cursor-agent` not found on PATH | Exit 4, structured error | Tell user to install Cursor CLI |
| `stall` | Silence watchdog fired (hang bug likely) | SIGKILL, collect partial output | Suggest smaller scope or retry |
| `total_timeout` | Total duration watchdog fired | SIGKILL, collect partial output | Suggest smaller scope |
| `rate_limited` | Provider rate-limited the request | Exit run, preserve others in panel | Suggest retry later |
| `network` | Network error reaching provider | Exit run | Check connectivity |
| `tool_refused` | Cursor refused to perform a tool action | Continue (non-fatal) | Report what/why to user |
| `cancelled` | User SIGINT or `/cursed:cancel` | Clean shutdown | Normal exit path |
| `parse_error` | stream-json malformed | Collect partial, mark run failed | Report as plugin bug |
| `session_invalid` | `--resume-last` session no longer exists | Exit run | Run without `--resume-last` |
| `worktree_failed` | Worktree creation failed (delegate) | Exit 2 | Investigate git state |
| `dirty_tree` | Working tree is dirty, policy=refuse | Exit 2 | Commit or stash first |
| `internal` | Unexpected wrapper-side error | Exit 1, stack trace to stderr | File bug with transcript |

---

## 15. Sandboxing (delegate-specific)

### 15.1 Dirty-tree policy

Before spawning `cursor-agent` for a `delegate` run, the wrapper checks:

```bash
git status --porcelain
git rev-parse HEAD
```

Policy options (default `warn`):

- **`refuse`** — if porcelain is non-empty, exit 2 with `dirty_tree` error. Safest.
- **`warn`** — emit a warning to stderr + include in output metadata; proceed.
- **`allow`** — no check. Only recommended when always pairing with `--worktree`.

### 15.2 Worktree isolation

`--worktree <branch>` flag:

1. Wrapper calls `git worktree add <path> <branch>` with a fresh branch off a configurable base (default: current HEAD).
2. Sets the spawned `cursor-agent` process's `cwd` to the new worktree path.
3. After the run, the worktree is **not** automatically removed (user inspects the diff, decides).
4. `git worktree remove <path>` is the user's responsibility, surfaced in the output.

**Open-cloche integration:** when `AW_RUN_ID` is set, the wrapper integrates with oc's `WorktreeManager` (Python; called via `aw` CLI helper) for worktree names that match oc conventions and auto-cleanup policies.

### 15.3 `--panel` requires `--worktree`

Enforced check in the wrapper. `--panel` without `--worktree` on `delegate` exits with a clear error:

```
ERROR: --panel on delegate requires --worktree. Three models writing
to the same working tree produces corrupt state. Specify --worktree
<branch-base> to run each model in an isolated worktree, then
review diffs with /cursed:review.
```

---

## 16. Open-cloche integration

### 16.1 Phase 1: drop-in (v0.1 / v0.2)

Install the plugin at the user level (`~/.claude/plugins/`). Any Claude agent running inside an oc workflow — i.e. any process spawned by `SpawnAgentAction` — automatically has `/cursed:*` available because it's a Claude Code plugin loaded at session start.

Agents can call `/cursed:rescue`-style helpers exactly as they would call `/codex:rescue`. No framework changes to `open_cloche/` needed.

Works in both local runs and containerized runs, provided `cursor-agent` is on PATH. For container runs, add `cursor-agent` to the `docker/` stage.

### 16.2 Phase 2: env-aware wrapper (v0.2)

The wrapper detects oc environment variables and integrates without oc framework changes:

**Env detection:**
```javascript
const ocContext = {
  run_id:   process.env.AW_RUN_ID,
  task_id:  process.env.AW_TASK_ID,
  agent_id: process.env.AW_AGENT_ID,
  session_id: process.env.AW_SESSION_ID
};
const isOcContext = !!ocContext.run_id;
```

**When running under oc context:**

1. Tag all log lines with `run_id=... task_id=... agent_id=...`.
2. On panel or solo completion, call:
   ```bash
   aw artifact attach \
     --type cursed_transcript \
     --path <transcript_path> \
     --metadata "{\"command\": \"review\", \"models\": [...], ...}"
   ```
3. Emit token usage to BigQuery via:
   ```bash
   aw bq write cursed_usage \
     --data "{\"models\": [...], \"input_tokens\": ..., \"output_tokens\": ..., \"command\": \"...\"}"
   ```
4. Errors go to `aw log` for visibility in the event feed.
5. `--worktree` integrates with oc's `WorktreeManager` conventions.

### 16.3 Phase 3: orchestrator-level runner (future, out of scope for v0.2)

Making oc workflows able to spawn `cursor-agent` as the primary agent runner (instead of `claude`) for entire tasks. This requires framework changes:

- `SpawnAgentAction` gets a `runner: Literal["claude", "cursor"]` field.
- `open_cloche.services.agent_spawner` dispatches on runner.
- Token parsers in `open_cloche.services.analytics` gain a Cursor parser.
- Sentinel's scrollback parsing needs tuning for Cursor output format.

Tracked as v0.3 future work. Not designed in this doc.

---

## 17. Testing strategy

### 17.1 Unit tests (vitest)

**`test/unit/stream.test.mjs`** — parser against recorded fixtures.

```javascript
import { describe, it, expect } from 'vitest';
import { parseStream } from '../../scripts/lib/stream.mjs';
import { readFile } from 'fs/promises';

describe('stream parser', () => {
  it('extracts assistant text from a clean review run', async () => {
    const fixture = await readFile('test/fixtures/stream-json/review-clean.jsonl');
    const result = await parseStream(fixture.toString());
    expect(result.text).toContain('Finding 1:');
    expect(result.files_changed).toEqual([]);
    expect(result.tokens.input).toBeGreaterThan(0);
  });

  it('handles malformed JSON gracefully', async () => {
    const fixture = '{"type": "valid"}\n{malformed}\n{"type": "valid"}';
    const result = await parseStream(fixture);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'parse_error' })
    );
    expect(result.raw_event_count).toBe(2);
  });

  it('extracts files_changed from tool_call events', async () => {
    const fixture = await readFile('test/fixtures/stream-json/delegate-edit.jsonl');
    const result = await parseStream(fixture.toString());
    expect(result.files_changed).toContain('src/foo.py');
  });
});
```

**`test/unit/watchdog.test.mjs`** — mock child process, verify escalation.

```javascript
import { describe, it, expect, vi } from 'vitest';
import { Watchdog } from '../../scripts/lib/watchdog.mjs';

describe('watchdog', () => {
  it('fires silence timeout when no events arrive', async () => {
    vi.useFakeTimers();
    const mockProc = new MockProcess();
    const w = new Watchdog(mockProc, { silence: 100, total: 10000 });
    w.start();
    vi.advanceTimersByTime(150);
    expect(mockProc.signals).toContain('SIGTERM');
  });

  it('escalates to SIGKILL if SIGTERM ignored', async () => {
    vi.useFakeTimers();
    const mockProc = new MockProcess({ ignoreSigterm: true });
    const w = new Watchdog(mockProc, { silence: 100, total: 10000 });
    w.start();
    vi.advanceTimersByTime(150);
    expect(mockProc.signals).toContain('SIGTERM');
    vi.advanceTimersByTime(6000);
    expect(mockProc.signals).toContain('SIGKILL');
  });

  it('resets silence on event', async () => {
    vi.useFakeTimers();
    const mockProc = new MockProcess();
    const w = new Watchdog(mockProc, { silence: 100, total: 10000 });
    w.start();
    vi.advanceTimersByTime(80);
    w.onEvent();
    vi.advanceTimersByTime(80);
    expect(mockProc.signals).toEqual([]);
  });
});
```

**`test/unit/panel.test.mjs`** — orchestration with mock `runOne`.

```javascript
it('returns partial panel when one run fails', async () => {
  const runOne = vi.fn()
    .mockResolvedValueOnce({ model: 'a', text: '...', status: 'completed' })
    .mockRejectedValueOnce(new Error('stall'))
    .mockResolvedValueOnce({ model: 'c', text: '...', status: 'completed' });
  const result = await runPanel({ models: ['a', 'b', 'c'], runOne });
  expect(result.summary.successful_runs).toBe(2);
  expect(result.summary.failed_runs).toBe(1);
  expect(result.runs.find(r => r.model === 'b').error.code).toBe('stall');
});
```

**`test/unit/models.test.mjs`** — tier selection, diversity algorithm.

**`test/unit/errors.test.mjs`** — error classification from stream events.

### 17.2 Smoke tests

**`test/smoke/setup.test.mjs`** — real `cursor-agent --version` invocation only. Verifies the plugin can detect the CLI. No API calls, no billing. Safe in CI.

### 17.3 Integration tests (env-gated)

Runs against real Cursor API; env-gated behind `CURSED_INTEGRATION=1`:

- `test/integration/review-small.test.mjs` — runs `/cursed:review` on a tiny committed diff; asserts at least one finding or an explicit "no issues" statement.
- `test/integration/panel-diverse.test.mjs` — forces panel of 2, verifies diversity in provider selection.
- `test/integration/delegate-worktree.test.mjs` — delegates a minimal edit; verifies worktree created, diff contains expected change.

CI runs unit + smoke by default. Integration runs on-demand locally or in a gated nightly job.

### 17.4 Fixture capture

During v0.1 development, capture real `cursor-agent` output:

```bash
node scripts/cursed.mjs run --command review --models gpt-5.4 ... \
  --debug-capture > test/fixtures/stream-json/review-real-1.jsonl
```

`--debug-capture` is a v0.1 dev-only flag that dumps raw stream events. Fixtures are committed (sanitized — no API keys, no sensitive repo content).

---

## 18. Observability

### 18.1 Structured logging

`CURSED_DEBUG=1` enables verbose logging to stderr. Format: NDJSON, one line per event.

```json
{"ts": "2026-04-24T14:23:01Z", "level": "info", "event": "panel_start", "command": "review", "models": ["gpt-5.4", "sonnet-4-6"], "run_id": "..."}
{"ts": "2026-04-24T14:23:02Z", "level": "debug", "event": "stream_parse", "model": "gpt-5.4", "event_count": 1}
{"ts": "2026-04-24T14:23:45Z", "level": "warn", "event": "watchdog_silence_warn", "model": "gemini-3", "silence_ms": 90000}
{"ts": "2026-04-24T14:24:15Z", "level": "error", "event": "watchdog_silence_fire", "model": "gemini-3", "action": "SIGTERM"}
{"ts": "2026-04-24T14:24:20Z", "level": "error", "event": "watchdog_sigkill", "model": "gemini-3"}
```

### 18.2 Token/cost tracking

Every run records:

```json
{
  "ts": "2026-04-24T14:23:01Z",
  "command": "review",
  "model": "gpt-5.4",
  "tokens": {"input": 4200, "output": 1800, "cache_read": 800, "cache_write": 0},
  "duration_ms": 42310,
  "status": "completed"
}
```

Appended to `$CLAUDE_PLUGIN_DATA/usage.jsonl`. `/cursed:usage` reads this and aggregates.

### 18.3 `/cursed:usage` output

```
Usage — past 7 days
────────────────────────────────────────────────────────
command        runs  input     output   cache_read  wall_hours
review           12  152,400   48,200   18,400       2.4
plan-review       3   89,200   22,100    4,100       1.1
delegate          8   34,100   12,500    2,200       0.7
advise            5   62,400   18,300    5,100       0.9

By model:
  gpt-5.4              22,500  ...
  claude-sonnet-4-6    16,200  ...
  gemini-3              8,800  ...

Failures: 3 (stall: 2, rate_limited: 1)
```

---

## 19. Roadmap

### 19.1 v0.1 — core usable (~1.5 days)

- [ ] Plugin skeleton (manifest, directory layout)
- [ ] `cursed.mjs` entry + subcommand routing
- [ ] `setup` subcommand: detect `cursor-agent`, probe auth, report JSON
- [ ] Single-model `run` subcommand (no panel yet)
- [ ] Stream-json parser with fixture-based tests
- [ ] Watchdog (silence + total + signal escalation)
- [ ] Prompt template loader with `{{VAR}}` substitution
- [ ] Session resume (`--resume-last` for solo runs)
- [ ] Structured error codes
- [ ] Four commands + subagent + prompts (all functional, solo mode only)
- [ ] `config.toml` loader (tier-less, just timeouts/defaults for v0.1)
- [ ] `models.default.json` bundled
- [ ] README with install + usage

### 19.2 v0.2 — robust, paneled, oc-aware (~2 days after v0.1)

- [ ] Parallel panel execution (`Promise.allSettled`)
- [ ] `--solo` / `--panel` / `--models` overrides
- [ ] Tier-based model selection + discovery
- [ ] Diversity algorithm
- [ ] Transcript persistence per run + panel aggregate
- [ ] `/cursed:result [job-id]` reads transcripts
- [ ] `/cursed:usage` with aggregation
- [ ] `/cursed:delegate` sandboxing (dirty-tree, worktree, diff report)
- [ ] `--panel` requires `--worktree` on delegate
- [ ] Full `config.toml` schema (per-command overrides, budget)
- [ ] oc env detection + `aw artifact attach` + `aw bq write` emission
- [ ] Background job support (`--background`, `status`, `cancel`)
- [ ] Complete test suite with fixtures
- [ ] CHANGELOG + version bump

**v0.2 ship summary (2026-04-25, retrospective).** Of the items in this section, v0.2 actually shipped:

- ✅ MCP-native transport (`scripts/mcp/cursed-mcp.mjs`).
- ✅ Panel mode for `review` and `plan-review` (3-model default for review; opt-in for plan-review).
- ✅ Diversity-aware model selection.
- ✅ New `using-cursed` skill for autonomous discovery.

Moved to v0.3:

- ⏭ Worktree isolation, `--background`, `/cursed:status`, `/cursed:cancel`, `/cursed:result`.
- ⏭ Runtime model discovery (parser for `cursor-agent models`).
- ⏭ Panel-delegate (depends on worktree).
- ⏭ `/cursed:usage` aggregation, cost estimation, budget warnings.

The shipped scope was decided in spec `docs/superpowers/specs/2026-04-24-cursed-v0.2-design.md`; the `cursed-design.md` document remains authoritative for the long-term roadmap.

### 19.3 v0.3 — polish + oc Phase 2.5 (~1 day after v0.2)

- [ ] Cost estimation + warn-before-panel-cost threshold
- [ ] `/cursed:discover-models --force` command
- [ ] Smarter tier heuristics in subagent (use `git diff --stat` output)
- [ ] Rate-limit-aware backoff timing
- [ ] Better stream-json event classification (based on real field data)
- [ ] Live progress streaming via MCP `notifications/message` (opt-in `[stream_progress] = true`). Spike Claude Code's rendering of MCP log notifications first; per-model tagging required for panel runs.
- [ ] Docs: architecture deep-dive, per-command guides, oc-integration guide

**v0.3.0-quality-tooling ship summary (2026-04-30, retrospective).** v0.3 paused the user-facing roadmap above for a maintainability-focused cycle. Tagged `v0.3.0-quality-tooling` at commit `41d6d31` on `main` (no `origin` remote — local fast-forward merges). Shipped scope is tracked in spec `docs/superpowers/specs/2026-04-27-cursed-quality-tooling-design.md` and plan `docs/superpowers/plans/2026-04-27-cursed-quality-tooling.md`:

- ✅ **Phase 1 — TypeScript checking via JSDoc.** `tsc --noEmit` with strict checks on `.mjs` and `.d.ts`; `scripts/lib/types.d.ts` introduced as a shared declaration file. CI workflow at `.github/workflows/ci.yml` ready (no remote yet).
- ✅ **Phase 2 — biome lint + format.** `npm run lint`, `npm run format`, `npm run format:check`. 47 files clean.
- ✅ **Phase 3 — `finalize-development` skill (internal-only pivot).** Mid-cycle decision: the skill orchestrates project-specific gates that only make sense for cursed maintainers, so it ships at `.claude/skills/finalize-development/SKILL.md` (auto-loaded only inside this repo) rather than under the plugin's `skills/`. Plugin consumers don't see it.
- ✅ **Side-quest — `tools/testbed/`.** Tmux-driven agentic testbed for spawning real Claude Code sessions and inspecting JSONL transcripts. Spec at `docs/superpowers/specs/2026-04-28-agentic-testbed-design.md`. Used to empirically verify the Phase 3 skill's auto-trigger and to discover that **skill descriptions truncate at ~30 chars** in the system-prompt skill listing — descriptions must lead with a distinctive prefix to win selection.

Deferred from the original v0.3 list above (still standing for v0.3.x or later):

- ⏭ Cost estimation + budget warnings.
- ⏭ `/cursed:discover-models --force`, smarter tier heuristics, rate-limit-aware backoff.
- ⏭ Better stream-json event classification, live progress streaming via MCP notifications.
- ✅ **Worktree isolation (Phase #1, 2026-05-07).** Solo-only (panel-delegate dropped per spec D5). Default dirty-tree policy is `refuse` (D2 — flips the master-design `warn` default). Spec: `docs/superpowers/specs/2026-05-06-cursed-worktree-isolation-design.md`. Plan: `docs/superpowers/plans/2026-05-07-cursed-worktree-isolation.md`.

Post-cycle follow-ups completed 2026-04-30 (this revision): `RunTimeouts` and `CommandTimeoutConfig` deduplicated to a single field-name scheme (`silence_timeout_seconds`/`total_timeout_seconds`), and the cosmetic type fixes from the Phase 1 review (`RunStatus` literal, `RunTimeouts` annotation, `partialPanel` test helper, `Watchdog._reason` narrowing).

### 19.4 v1.0 — orchestrator-level integration (future, separate track)

- `SpawnAgentAction(runner="cursor")` in `open_cloche`
- Parallel framework track in oc repo
- Not blocking `cursed` plugin releases

---

## 20. Decisions log

### D1. Node, not Python or Go

**Decision:** Node (`.mjs`, Node 20+).

**Reasoning:**
- Users of this plugin already have Node installed (`cursor-agent` is an npm package).
- Matches codex precedent — both plugins look and feel the same to users.
- Cold start (~50ms) meaningfully better than Python (~250ms) for a slash-command tool.
- Stream-json parsing is native with `node:readline`.
- Go's static-binary distribution adds platform-matrix complexity inside the plugin file tree without meaningful performance gain at this scale.

**What we lose:** tight integration with open-cloche's Python runtime — but we don't actually need it. oc integration happens via shelling out to `aw` CLI, language-agnostic.

### D2. Parent Claude synthesizes panel results

**Decision:** The wrapper returns structured PanelResult; parent Claude synthesizes.

**Reasoning:**
- A 4th synthesizer LLM call re-introduces the bandwagon problem we're designing against.
- Parent Claude has user context and can make editorial judgments the wrapper cannot.
- Keeps wrapper stateless and composable.

**What we lose:** consistency across invocations (different parent Claudes may present slightly differently). Accepted trade-off — command markdown documents the presentation rules.

### D3. Tier-based model selection, not concrete names

**Decision:** Commands reference tiers (`fast` / `balanced` / `reasoning`); wrapper resolves to concrete models at runtime.

**Reasoning:**
- Model names rot (gpt-5.4 → gpt-5.5 → ...).
- Tiers are stable semantic categories.
- Discovery against `cursor-agent` keeps the catalog fresh without user intervention.

**What we lose:** users wanting reproducibility across runs must pin with `--models`. Acceptable — that's a rare case and the flag exists for it.

### D4. Discovery-first, static fallback

**Decision:** `/cursed:setup` queries `cursor-agent models list` (or equivalent); falls back to bundled `models.default.json`.

**Reasoning:**
- If Cursor CLI exposes model listing, we stay fresh automatically.
- If not, fallback ensures the plugin works; we update `models.default.json` per release.

**Open question:** does `cursor-agent` actually expose machine-readable model listing? See §21.

### D5. No repo-root config file

**Decision:** All config lives in `$CLAUDE_PLUGIN_DATA/config.toml` (user-level). Per-project overrides via env vars only.

**Reasoning:**
- Matches codex convention.
- No discovery walk up directory trees.
- Env vars + `direnv` cover per-project needs for users who want them.
- One source of truth for "what does `/cursed:review` do by default."

### D6. Subagent chooses tier + count at call-time

**Decision:** The `cursed-worker` subagent inspects the task (diff size, file paths, user intent) and picks `--tier` and `--count` before invoking the wrapper. User overrides are escape hatches, not the primary interface.

**Reasoning:**
- Fewer user-facing flags, more intelligent defaults.
- Task-appropriate sizing (small diff = 1 reviewer; migration = 3).
- Heuristics iterable without touching runtime code.
- Reason logged in output (`selected_reason`) for transparency.

### D7. `/cursed:delegate --panel` requires `--worktree`

**Decision:** Enforced in the wrapper; refuses otherwise.

**Reasoning:**
- Three models writing the same tree = corrupt state.
- Worktrees provide clean isolation; user compares diffs with `/cursed:review` afterward.
- Safer default than any retrofit.

### D8. No 4th LLM call for synthesis

See D2.

### D9. Name is `cursed`

**Decision:** Plugin name is `cursed`. Bare, single word.

**Reasoning:**
- Captures the "adversarial critic" stance without embedding either `claude` or `cursor` in the name (reduces trademark surface).
- Memorable, short.
- Command namespace reads coherently: `/cursed:review`, `/cursed:plan-review`, `/cursed:delegate`, `/cursed:advise`.

**Known risk:** "cursed" has negative-connotation baggage; trademark tarnishment theoretically possible. Mitigated by:
- Strong disclaimers in README and plugin.json.
- No use of Anthropic or Cursor logos.
- Neutral marketing copy.

### D10. `--panel` is opt-in for advise; panel by default for review

**Decision:** `review` defaults to panel; `advise` defaults to solo.

**Reasoning:**
- Review benefits from divergent critical voices.
- Advice wants decisiveness — three hedged advisors produce worse outcomes than one decisive one.
- Users can override in either direction.

---

## 21. Open questions / assumptions to verify

These questions need empirical answers in the first hours of v0.1 development. Each has a working assumption so design isn't blocked, but real answers may shift details.

### Q1. What does `cursor-agent` emit in `--output-format stream-json`?

**Assumption:** NDJSON, one event per line, with `type` discriminator. Event types cover: session start/end, assistant text fragments, tool calls, tool results, errors.

**Verify:** Run `cursor-agent -p "test task" --output-format stream-json` locally, capture a few sessions, document real schema. May differ significantly from assumed types.

**Impact if wrong:** `stream.mjs` parser rewrites. Relatively contained.

### Q2. Does `cursor-agent` expose machine-readable model listing?

**Assumption:** Yes — `cursor-agent models list --json` or similar.

**Verify:** Check Cursor CLI docs and try variants.

**Impact if no:** Discovery path falls back to static `models.default.json`. Plugin still works; updates require plugin releases.

### Q3. How does session resume work?

**Assumption:** `--resume-session <id>` or `--resume-last`. Session IDs exposed in stream events.

**Verify:** Read Cursor CLI docs, test flow.

**Impact if different:** `--resume-last` feature changes shape. Solo-only commands still work fine.

### Q4. What's the actual hang-bug behavior?

**Assumption:** Per [forum report](https://forum.cursor.com/t/cursor-agent-p-print-headless-mode-hangs-indefinitely-and-never-returns/150246), `cursor-agent -p` can hang without emitting events.

**Verify:** Try to reproduce locally with a few prompts. Document conditions. Tune silence timeout defaults.

**Impact:** Silence watchdog must be robust day 1. This is load-bearing infrastructure.

### Q5. Does `cursor-agent` honor `CURSOR_API_KEY` env, or require `cursor login`?

**Assumption:** Both work.

**Verify:** Test both paths. Document which is preferred for CI.

**Impact:** `/cursed:setup` probe logic and docs.

### Q6. What does `cursor-agent` return for rate-limit errors?

**Assumption:** A stream event with error type / message containing "rate limit" or HTTP 429 equivalent.

**Verify:** Hard to test proactively. Document when encountered in the wild.

**Impact:** Error classification in `errors.mjs`.

### Q7. How does Cursor handle the `AGENTS.md` / `CLAUDE.md` convention?

**Assumption:** Cursor reads these automatically.

**Verify:** Test with a sample repo. Confirm our prompt templates compose correctly with repo-level guidance.

**Impact:** Prompt template design. If Cursor auto-injects `CLAUDE.md`, our `{{REPO_GUIDANCE}}` placeholder may be redundant or need different sourcing.

### Q8. Will Anthropic or Anysphere object to the name `cursed`?

**Assumption:** Low risk given (a) no trademark names embedded, (b) clear disclaimers, (c) small initial user base.

**Verify:** Monitor for contact. Keep a rename path ready.

**Impact:** Rename requires sed + repo rename + version bump. Not hard, but annoying once users exist.

---

## 22. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cursor hang bug hits a user in the wild | High | Medium | Silence watchdog with aggressive default (90–120s) |
| `cursor-agent` schema changes break parser | Medium | High | Fixture-based parser tests; integration test in nightly CI |
| Trademark complaint on `cursed` name | Low | Medium | Disclaimers; rename path ready |
| User panel runs blow through Cursor quota | Medium | Low | Budget warning in config; `/cursed:usage` visibility |
| Panel synthesis by parent Claude is inconsistent | Medium | Low | Document presentation rules in each command markdown |
| `/cursed:delegate --panel` corrupts user's tree | Low (blocked) | High | Hard refusal in wrapper without `--worktree` |
| Background jobs orphaned after crash | Medium | Low | Reconciliation on plugin startup |
| Model catalog gets stale | Medium | Low | 7-day TTL on discovery cache; `/cursed:discover-models --force` |

---

## 23. References

- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — advisor/executor pattern source
- [Cursor headless CLI docs](https://cursor.com/docs/cli/headless)
- [Cursor Agent CLI blog post](https://cursor.com/blog/cli)
- [Cursor `-p` hang bug report (Jan 2026)](https://forum.cursor.com/t/cursor-agent-p-print-headless-mode-hangs-indefinitely-and-never-returns/150246)
- [Anthropic trademark policy](https://www.anthropic.com/trademark-policy) — for disclaimer wording

---

## Appendix A: full prompt templates (ready-to-ship drafts)

### A.1 `prompts/review.md`

```markdown
You are an adversarial code reviewer. Another agent produced this work;
your job is to find problems, not validate.

Ground rules:
- Do not default to agreement. If the change is wrong, say so directly.
- If nothing is wrong, say so explicitly — do not invent issues to seem useful.
- Do not rewrite the code or propose replacements.
- Focus on: correctness, hidden assumptions, edge cases, security,
  operational failure modes, unchecked invariants.
- Each finding, structured:
    - location: specific file:line or function
    - problem: what is wrong
    - consequence: what breaks as a result
    - confidence: high | medium | low
- No softening phrases ("you might want to consider", "it could be worth").
  Either flag a problem or don't.
- If you disagree with the change's premise, say so first and separately
  from line-level findings.

Scope under review: {{SCOPE}}

Repository conventions (if relevant): {{REPO_GUIDANCE}}
```

### A.2 `prompts/plan-review.md`

```markdown
You are reviewing a plan against the actual code it claims to modify.
The plan may be wrong about the code, wrong about the approach, or both.

For every claim the plan makes about existing behavior:
- verify by reading the code
- note any claim that does not match reality
- cite the specific file:line you checked

For every proposed change, identify concrete failure modes:
- wrong assumptions (about APIs, data shapes, invariants)
- missing edge cases
- unjustified abstractions or scope creep
- sequencing bugs (step A assumes step B already done, but step B is later)
- implicit migrations without a plan
- breaking changes to callers not listed

Do not rewrite the plan. Do not propose a better plan. Your only job is
to enumerate problems with the plan as written.

If the plan is sound, say so — and list the specific verifications you ran
to reach that conclusion.

Plan file: {{PLAN_PATH}}
Referenced code paths: {{CODE_PATHS}}
```

### A.3 `prompts/delegate.md`

```markdown
You are being handed a single scoped task. Execute it — do not expand
scope, do not refactor adjacent code, do not add tests that were not
requested.

Rules:
- Make the minimal change that satisfies the task.
- If the task is ambiguous, ask one clarifying question before
  proceeding. Do not guess and proceed.
- Respect existing file structure and naming conventions.
- Do not add dependencies without calling that out.
- Before finishing, verify the change by running whatever local
  validation the repo supports (tests, type-check, lint) if appropriate
  for the task.

When done, report exactly:
  1. Files changed (full paths)
  2. What the change does (one paragraph)
  3. What you ran to validate it (commands + exit codes)
  4. Anything you noticed but did not fix (list, or "none")

Task: {{TASK}}

Repository conventions: {{REPO_GUIDANCE}}
```

### A.4 `prompts/advise.md`

```markdown
You are an advisor in an executor/advisor pattern. The executing agent
(another Claude) has stopped at a decision it cannot confidently resolve.
You have access to the shared context below.

Return exactly one of these three:

1. A concrete plan — specific steps the executor should take, in order.
   Include: what tools to invoke, what files to read or write, what the
   expected outcome is, and how to verify it worked.

2. A correction — a flawed assumption in the executor's reasoning,
   with what to replace it with. Point to the specific part of the
   context that is wrong.

3. A stop signal — a reason the executor should halt and report back to
   the human, including what information the human needs to decide.

Rules:
- Do not implement. Do not write code. Do not modify files.
- Be decisive. "It depends" is not a valid response — either give the
  condition under which each branch applies, or pick one.
- Reference the specific part of the context that informs your advice.
- If the decision point is ambiguous, return a stop signal, not a guess.

Decision point: {{QUESTION}}

Shared context: {{CONTEXT}}
```

---

## Appendix B: subagent markdown (draft)

`agents/cursed-worker.md`:

```markdown
---
name: cursed-worker
description: Internal forwarder for /cursed:* commands. Inspects task scope, chooses tier/count, invokes scripts/cursed.mjs run. Not user-facing.
model: sonnet
tools: Bash
skills:
  - cursed-runtime
---

You are a forwarder for the `cursed` plugin. Your only job is to inspect
the user's request, decide panel sizing, and invoke the runtime.

## Panel sizing heuristics

For `/cursed:review`:
- Inspect: `git diff --stat <target>` (target defaults to `main...HEAD`)
- diff < 100 LOC, low-risk area: --count 1 --tier balanced
- diff 100-500 LOC or shared infra: --count 2 --tier balanced --diverse
- diff > 500 LOC, migrations, security, concurrency: --count 3 --tier reasoning --diverse

For `/cursed:plan-review`:
- Inspect plan file size + list of referenced code paths
- short plan (<200 lines), small expected change: --count 1 --tier reasoning
- medium/large plan or touches multiple subsystems: --count 2 --tier reasoning --diverse

For `/cursed:delegate`:
- Always --count 1
- --tier balanced unless task mentions "architecture", "migration",
  "security", "concurrency" → --tier reasoning
- Default --write (delegate is write-capable)

For `/cursed:advise`:
- Always --count 1 --tier reasoning
- --panel only if user explicitly asks ("get second opinions on this")

## User overrides

If user includes any of these, they win over your judgment:
- `--solo` → force --count 1
- `--panel` → force --count 3 (or profile default, whichever is greater)
- `--models <list>` → pass through as --models, skip tier resolution

## Invocation

Use exactly one Bash call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursed.mjs" run \
  --command <name> \
  --tier <tier> \
  --count <n> \
  [--diverse] \
  [--target <ref>] \
  [--worktree <branch>] \
  [--models <list>] \
  [--vars '{"TASK": "...", "SCOPE": "..."}']
```

Return the stdout verbatim. Do not summarize, rewrite, or add commentary.

## Rules

- Do not inspect or modify the repository beyond `git diff --stat` /
  `git rev-parse HEAD` / `ls <plan-file>` for sizing decisions.
- Do not read the code being reviewed — that's cursor-agent's job.
- Do not propose fixes, draft findings, or do any review work yourself.
- Report what you chose and why in your invocation (via --vars);
  the runtime includes it in the output as `selected_reason`.
```

---

## Appendix C: example end-to-end output

User types: `/cursed:review`

Wrapper stdout (returned through subagent):

```json
{
  "panel": true,
  "command": "review",
  "runs": [
    {
      "model": "gpt-5.4",
      "tier": "balanced",
      "status": "completed",
      "session_id": "cur_7f3a",
      "text": "Finding 1 (high confidence): open_cloche/services/agent_spawner.py:142 — race condition...\n\nFinding 2 (medium): ...\n\nNo issues found in: ...",
      "files_changed": [],
      "commands_run": [],
      "tokens": {"input": 8420, "output": 2150, "cache_read": 1200, "cache_write": 0},
      "duration_ms": 38220,
      "transcript_path": ".../2026-04-24/142301-review-gpt-5.4.jsonl",
      "exit_reason": "completed"
    },
    {
      "model": "claude-sonnet-4-6",
      "tier": "balanced",
      "status": "completed",
      "session_id": "cur_9b2d",
      "text": "Review findings:\n\n1. [high] open_cloche/services/agent_spawner.py:142 — spawn race with tmux session...\n\n2. [high] .wait() missing timeout...\n\nNo concerns in...",
      "files_changed": [],
      "commands_run": [],
      "tokens": {"input": 8420, "output": 2400, "cache_read": 1200, "cache_write": 0},
      "duration_ms": 44100,
      "transcript_path": ".../2026-04-24/142301-review-claude-sonnet-4-6.jsonl",
      "exit_reason": "completed"
    }
  ],
  "summary": {
    "wall_duration_ms": 44100,
    "total_tokens": {"input": 16840, "output": 4550, "cache_read": 2400, "cache_write": 0},
    "successful_runs": 2,
    "failed_runs": 0
  },
  "selected_reason": "diff 340 LOC across open_cloche/services/agent_spawner.py; medium, shared infra → --count 2 --tier balanced --diverse",
  "oc_context": null
}
```

Parent Claude's user-facing synthesis:

```
Two reviewers (gpt-5.4, claude-sonnet-4-6) reviewed the 340-LOC change
in open_cloche/services/agent_spawner.py.

Consensus findings (flagged by both, high confidence):
  1. Race condition at agent_spawner.py:142 — tmux session creation and
     task lookup can interleave under concurrent spawns.
  2. .wait() call at agent_spawner.py:168 lacks a timeout; hangs block
     the orchestrator indefinitely.

Divergence:
  - gpt-5.4 flagged a potential file-descriptor leak in the subprocess
    path (medium confidence).
  - sonnet-4-6 did not flag this; focus was higher-level.

Both reviewers: no concerns with the logging changes or the config
validation path.

Run details: 2 models, 44.1s wall time, $0.XX estimated (16.8k input,
4.6k output tokens).
```

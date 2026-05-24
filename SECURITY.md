# Security Policy

`cursed` orchestrates external model providers and feeds them source code from your working tree. That makes it a useful target — please report issues responsibly.

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

Report privately through one of:

- **GitHub Security Advisory (preferred):** [Report a vulnerability](https://github.com/roiperlman/cursed/security/advisories/new) — uses GitHub's private disclosure flow.
- **Email:** roi.perlman@gmail.com — subject prefix `[cursed security]`.

Please include:

- A description of the issue and its impact.
- A minimal reproducer (commit SHA / version, exact command, redacted transcript if relevant).
- Whether the issue is currently public anywhere.

We'll credit reporters in the advisory unless you ask us not to. There is no paid bug bounty.

## Response-time SLAs

These are targets, not guarantees — `cursed` is a small open-source project.

| Stage | Target |
|---|---|
| Initial acknowledgement | **3 business days** of receipt |
| Triage + severity decision | **7 business days** |
| Patch / mitigation | Best-effort; tracked in the advisory |
| Public disclosure | Coordinated with the reporter, typically after a patched release is on npm |

## Supported versions

Only the latest minor receives security fixes. Older minors are end-of-life on the day a new minor is released.

| Version | Supported |
|---|---|
| 0.2.x (latest minor) | ✅ |
| < 0.2 | ❌ |

If a fix is non-trivial to backport and you depend on an older line, say so in the report and we'll discuss.

## What counts as a vulnerability in cursed

`cursed` is a thin router between Claude Code and non-Anthropic CLI adapters (Cursor, Codex, Gemini, Antigravity). Anything that breaks the trust boundaries below is in scope.

**In scope:**

- **Prompt-injection paths that exfiltrate repo content.** An attacker-controlled file, diff, plan, or stdout from a worktree convinces an adapter to read files outside the requested scope, paste secrets into the model transcript, or post repo contents to an external network endpoint. Includes injection via review targets, advise context files, delegate task text, and adapter stream output.
- **Accidental key / credential leakage.** `CURSOR_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, OAuth tokens, or any other provider secret appearing in logs, error messages, panel result JSON, MCP notifications, telemetry, background-job artifacts, or anything written to disk under `$CLAUDE_PLUGIN_DATA` or `.cursed/`. Echoing a secret into a worktree commit also counts.
- **Adapter sandbox escapes.** `/cursed:delegate` is documented to write only to the current working tree (or, with `--worktree`, only inside `.cursed/worktrees/<name>/`). A vulnerability is anything that lets the adapter write outside that boundary, execute commands at higher privilege than the parent Claude Code session, persist after `--worktree` cleanup, or escape the dirty-tree refusal policy.
- **Background-job escape or persistence.** Background `/cursed:delegate` jobs that survive cancel, retain credentials past the configured retention window, or run code post-cancel.
- **MCP server vulnerabilities** in `scripts/mcp/cursed-mcp.bundled.mjs` — command injection, path traversal, unauthorized tool invocation, or auth bypass.

**Out of scope:**

- The underlying model returning incorrect, biased, or low-quality output. `cursed` does not validate model judgement.
- Vulnerabilities in the upstream CLIs themselves (`cursor-agent`, `codex`, `gemini`, `agy`) — report those to their respective vendors. We will still triage cases where `cursed`'s usage of those CLIs is what introduces the risk.
- Bugs that only matter when an attacker already has shell access on the developer's machine.
- Rate-limiting or cost-control issues from the model providers (not a security boundary `cursed` enforces).
- Findings against unsupported versions (see above).

If you're unsure whether something qualifies, send it anyway and we'll triage.

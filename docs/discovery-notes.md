# cursor-agent stream-json — discovery notes

**Captured:** 2026-04-24
**Cursor version:** 2026.04.17-787b533
**Invocation:** `cursor-agent --print --output-format stream-json --force "<prompt>"`

> Note: the plan recipe `cursor-agent -p "<prompt>" --output-format stream-json` is WRONG.
> `-p` / `--print` is a boolean flag; the prompt is a positional argument. The correct form is above.
> `--force` bypasses the workspace-trust prompt in new/untrusted directories.

---

## Event types observed

All events are NDJSON — one JSON object per line. Every event has a `type` field; some also have a `subtype`. The canonical discriminator is `type` (+ `subtype` where present).

| type | subtype | Description |
|---|---|---|
| `system` | `init` | Session start; first event; contains session metadata |
| `user` | — | Echoes the user prompt |
| `tool_call` | `started` | Model invoked a tool |
| `tool_call` | `completed` | Tool finished; result attached inline |
| `thinking` | `delta` | Streaming reasoning trace fragment |
| `thinking` | `completed` | End of thinking stream |
| `assistant` | — | Final assistant message; single event, not streamed in partials |
| `result` | `success` | Session end; tokens and duration |

Not observed (likely exist): `result/error`, `error`, rate-limit events, `writeToolCall`, `grepToolCall`, `listToolCall`.

---

## Canonical event shapes

### system/init

```json
{
    "type": "system",
    "subtype": "init",
    "apiKeySource": "login",
    "cwd": "/private/tmp/cursed-scratch",
    "session_id": "e3a00e7a-7b5a-4ab2-985b-4569a095ce0b",
    "model": "Composer 2 Fast",
    "permissionMode": "default"
}
```

Fields of interest:
- `session_id`: UUID v4, appears here first, echoed in every subsequent event
- `model`: display name of the model (e.g. `"Composer 2 Fast"`)
- `apiKeySource`: `"login"` when using Keychain/`cursor login` path
- `permissionMode`: `"default"` in all observed fixtures

### user

```json
{
    "type": "user",
    "message": {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Print the word hello and exit. Do not create any files."
            }
        ]
    },
    "session_id": "673ec19e-2874-4787-8c79-895d98ea6088"
}
```

Fields of interest:
- `message.content`: array of content blocks (same shape as Anthropic API messages)

### tool_call/started

```json
{
    "type": "tool_call",
    "subtype": "started",
    "call_id": "tool_b987e8d0-42a0-4bb4-9f05-f45acc9a6c7",
    "tool_call": {
        "readToolCall": {
            "args": {
                "path": "/private/tmp/cursed-scratch/sample.txt"
            }
        }
    },
    "model_call_id": "c6a942ec-b772-4842-8869-dce0689cda27-0-ztq0",
    "session_id": "e3a00e7a-7b5a-4ab2-985b-4569a095ce0b",
    "timestamp_ms": 1777041143176
}
```

Fields of interest:
- `call_id`: unique per tool invocation (used to match started ↔ completed)
- `tool_call`: wrapper object; the single key is the tool type name (e.g. `readToolCall`, `editToolCall`, `shellToolCall`)
- `tool_call.<name>.args`: tool arguments
- `model_call_id`: identifies the model turn that triggered this tool

### tool_call/completed

```json
{
    "type": "tool_call",
    "subtype": "completed",
    "call_id": "tool_b987e8d0-42a0-4bb4-9f05-f45acc9a6c7",
    "tool_call": {
        "readToolCall": {
            "args": {
                "path": "/private/tmp/cursed-scratch/sample.txt"
            },
            "result": {
                "success": {
                    "content": "line one\nline two\n",
                    "isEmpty": false,
                    "exceededLimit": false,
                    "totalLines": 3,
                    "fileSize": 18,
                    "path": "/private/tmp/cursed-scratch/sample.txt",
                    "readRange": { "startLine": 1, "endLine": 3 },
                    "relatedCursorRulePaths": [],
                    "relatedCursorRules": []
                }
            }
        }
    },
    "model_call_id": "c6a942ec-b772-4842-8869-dce0689cda27-0-ztq0",
    "session_id": "e3a00e7a-7b5a-4ab2-985b-4569a095ce0b",
    "timestamp_ms": 1777041143311
}
```

Fields of interest:
- `tool_call.<name>.result.success`: the result payload (keyed under `success`)

### thinking/delta

```json
{
    "type": "thinking",
    "subtype": "delta",
    "text": "The user wants me to",
    "session_id": "94277582-aa59-491f-8b3c-7c869e0109f2",
    "timestamp_ms": 1777041182653
}
```

### thinking/completed

```json
{
    "type": "thinking",
    "subtype": "completed",
    "session_id": "94277582-aa59-491f-8b3c-7c869e0109f2",
    "timestamp_ms": 1777041183548
}
```

### assistant

```json
{
    "type": "assistant",
    "message": {
        "role": "assistant",
        "content": [
            {
                "type": "text",
                "text": "hello"
            }
        ]
    },
    "session_id": "673ec19e-2874-4787-8c79-895d98ea6088"
}
```

Fields of interest:
- `message.content`: array of content blocks; text is under `content[n].text` where `content[n].type == "text"`
- This is a **single terminal event** — there are no streaming partial assistant events (`assistant_partial` does not exist; see §Deviations)

### result/success

```json
{
    "type": "result",
    "subtype": "success",
    "duration_ms": 3910,
    "duration_api_ms": 3910,
    "is_error": false,
    "result": "Update complete. `sample.txt` now has three lines.",
    "session_id": "e3a00e7a-7b5a-4ab2-985b-4569a095ce0b",
    "request_id": "c6a942ec-b772-4842-8869-dce0689cda27",
    "usage": {
        "inputTokens": 5968,
        "outputTokens": 199,
        "cacheReadTokens": 17952,
        "cacheWriteTokens": 0
    }
}
```

Fields of interest:
- `usage`: token counts (camelCase); only present when tokens were consumed (absent in simple runs — verified in `hello.jsonl`)
- `result`: plain-text summary of the run
- `duration_ms` / `duration_api_ms`: wall time and API time in milliseconds

---

## Session-id

- **First appears** in `system/init` at top-level `.session_id`
- **Format:** UUID v4 (e.g. `e3a00e7a-7b5a-4ab2-985b-4569a095ce0b`)
- **Echoed** in every subsequent event at `.session_id`
- **Also appears** in `result/success` at `.session_id` and `.request_id` (request_id is a separate UUID)

---

## Tool-call events

Tool calls are carried as `tool_call/started` + `tool_call/completed` pairs, matched by `call_id`.

The actual tool is nested under `tool_call.<toolTypeName>`, where `<toolTypeName>` is a camelCase string identifying the tool. Observed tool type names:

### readToolCall

```
tool_call.readToolCall.args.path              — path to read
tool_call.readToolCall.result.success.content — file contents
tool_call.readToolCall.result.success.totalLines
tool_call.readToolCall.result.success.fileSize
tool_call.readToolCall.result.success.readRange.{startLine,endLine}
```

### editToolCall

```
tool_call.editToolCall.args.path              — path to write
tool_call.editToolCall.args.streamContent     — new file content (full replacement)
tool_call.editToolCall.result.success.path
tool_call.editToolCall.result.success.linesAdded
tool_call.editToolCall.result.success.linesRemoved
tool_call.editToolCall.result.success.diffString
tool_call.editToolCall.result.success.beforeFullFileContent
tool_call.editToolCall.result.success.afterFullFileContent
```

Use `editToolCall` (not `writeToolCall`) to detect file edits. For extracting `files_changed`, check `tool_call.editToolCall.args.path` in `completed` events.

### shellToolCall

```
tool_call.shellToolCall.args.command          — the shell command string
tool_call.shellToolCall.args.workingDirectory
tool_call.shellToolCall.args.timeout          — ms
tool_call.shellToolCall.args.simpleCommands   — array of command names (parsed)
tool_call.shellToolCall.result.success.command
tool_call.shellToolCall.result.success.exitCode
tool_call.shellToolCall.result.success.stdout
tool_call.shellToolCall.result.success.stderr
tool_call.shellToolCall.result.success.executionTime
```

Use `shellToolCall` (not `shell`) to detect shell commands. For extracting `commands_run`, check `tool_call.shellToolCall.args.command` in `completed` events.

---

## Token / duration emission

Tokens and duration arrive **only at session end** in the `result/success` event — never incrementally.

Field paths:
```
result/success.usage.inputTokens
result/success.usage.outputTokens
result/success.usage.cacheReadTokens
result/success.usage.cacheWriteTokens
result/success.duration_ms
result/success.duration_api_ms
```

Note: `usage` is absent from `result/success` when the run consumed no tokens (observed in `hello.jsonl` — a short run where Cursor used no model API tokens).

---

## Assistant text

**Single final event, not streaming partials.**

The `assistant` event carries the complete response in `message.content`, which is an array of content blocks. Text is at `content[n].text` where `content[n].type == "text"`. There are no `assistant_partial` streaming events.

There is also a `result.result` plain-text field in `result/success` that duplicates the assistant's summary text. Both can be used; `assistant.message.content` is the richer structured form.

---

## Auth behavior (Q5)

- **`cursor login` / macOS Keychain:** YES — confirmed working. The CLI reads tokens from macOS Keychain:
  - Service `cursor-access-token`, account `cursor-user` (access token)
  - Service `cursor-refresh-token`, account `cursor-user` (refresh token)
- **`CURSOR_API_KEY` env var:** NOT tested explicitly in captured runs; `--help` shows `--api-key <key>` flag with `CURSOR_API_KEY` env support. Untested.
- **Preferred for headless:** `cursor login` (Keychain) — confirmed by `apiKeySource: "login"` in every `system/init` event.
- **Note:** The Cursor IDE's auth store (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`) is a separate vscdb. The CLI does NOT read from there; tokens must be in Keychain.

---

## Model listing (Q2)

**Confirmed working:** `cursor-agent models` (no subcommand, no `--json` flag).

Output is plain-text, one model per line in the format `<id> - <display name>`. Example:
```
composer-2-fast - Composer 2 Fast (current, default)
composer-2 - Composer 2
claude-4-sonnet - Sonnet 4
gpt-5.2 - GPT-5.2
```

Full catalog as of 2026-04-24: 50+ models including Composer 2, Claude 4/4.5/4.6/4.7 series, GPT-5.x Codex variants, Grok 4.20, Gemini 3 Flash, Kimi K2.5, and others.

**`cursor-agent --list-models`** is also supported and produces the same output.

**No `--json` flag exists** for model listing. Output is plain-text only; parsing requires splitting on ` - `.

**Alternative:** `cursor-agent models` subcommand has no additional options (just `-h`).

**Consequence for Task 2.7 / setup:** `cursor-agent models` output must be parsed as plain text. The static `models.default.json` fallback remains relevant for CI environments without auth.

---

## Session resume (Q3)

From `cursor-agent --help`:

- **`--resume [chatId]`**: Select a session to resume (default: false). If `chatId` is omitted, behavior is to show a session picker (interactive). Passing a chat ID resumes that session.
- **`--continue`**: Continue the previous session (boolean flag, default: false).
- **`cursor-agent resume`** subcommand: Resume the latest chat session (no options beyond `-h`).
- **`cursor-agent ls`** subcommand: Resume a chat session (interactive picker — requires a TTY; errors with "Raw mode not supported" in headless scripts).
- **`cursor-agent create-chat`**: Create a new empty chat and return its ID.

**Session IDs:** UUID v4, emitted in `system/init.session_id`. These are chat/session IDs usable with `--resume <id>`.

**Verdict for v0.1:** Session resume IS supported via `--resume <session_id>`. The flag is `--resume <chatId>`, not `--resume-last` or `--resume-session`. Use `system/init.session_id` as the resume ID. The `--continue` flag resumes the most recent session (equivalent of `--resume-last`).

**Correction to master design §2.1 assumption:** The flag is `--resume <chatId>` (not `--resume-session <id>`), and `--continue` serves the `--resume-last` role. Session resume can proceed in Phase 4 with these corrected flag names.

---

## Hang-bug observations (Q4)

The stall-attempt fixture (`stall-attempt.jsonl`) completed normally — 11 events, including `result/success`. The hang was **not reproduced** during capture.

The hang bug (reported at Cursor forum) manifests as `cursor-agent` emitting no events and never returning. This may be environment-specific or intermittent.

**Recommendation:** Default silence timeout of **120 seconds** per master design §9.2. The watchdog is load-bearing infrastructure regardless of whether the bug reproduces in development. The stall-attempt fixture is still useful for testing watchdog cancellation in integration tests.

---

## Deviations from master design §8.2 assumptions

Master design §8.2 assumed the following event types. Actual observations differ:

| §8.2 assumed type | Actual type | Notes |
|---|---|---|
| `session_start` | `system` / `init` | `type:"system"`, `subtype:"init"`. Fields differ: has `apiKeySource`, `cwd`, `model`, `permissionMode`, `session_id`. |
| `session_end` | `result` / `success` | `type:"result"`, `subtype:"success"`. Token field names are camelCase (`inputTokens`, not `input_tokens`). |
| `assistant_message` | `assistant` | `type:"assistant"`. Text is nested at `message.content[n].text` (content block array), not a flat `text` field. |
| `assistant_partial` | **does not exist** | No streaming partial assistant events. The `assistant` event is the complete terminal message. The `--stream-partial-output` flag exists but emits additional delta events (not tested); those are NOT the `assistant_partial` type assumed. |
| `tool_call` | `tool_call` / `started` | Type matches but shape differs: tool name is a wrapper key under `tool_call` (e.g. `tool_call.readToolCall`), not a flat `name` field. Arguments are at `tool_call.<name>.args`, not `tool_call.arguments`. |
| `tool_result` | `tool_call` / `completed` | No separate `tool_result` event. Result is inlined into the `completed` variant of `tool_call`, at `tool_call.<name>.result.success`. |
| `error` | **not observed** | Not seen in any fixture. May exist as `result/error` (subtype). No separate `error` event type confirmed. |
| `thinking` | `thinking` / `delta` + `thinking` / `completed` | Type matches. Subtype required to distinguish fragments from end-of-thinking marker. |

**Summary for Task 2.1 parser:**
- Parse `type` + `subtype` together as the discriminator.
- Extract session_id from `system/init`.
- Extract tokens from `result/success.usage` (camelCase fields).
- Extract assistant text from `assistant.message.content[n].text` where `content[n].type == "text"`.
- Detect file changes via `tool_call/completed` where `tool_call.editToolCall` key exists; path at `tool_call.editToolCall.args.path`.
- Detect shell commands via `tool_call/completed` where `tool_call.shellToolCall` key exists; command at `tool_call.shellToolCall.args.command`.
- No `tool_result` event to handle — results are inline in `tool_call/completed`.

---

## Phase 0 hard-gate evaluation

Evaluated against the four gate conditions (plan lines 310–319):

1. **Events are NDJSON?** YES — one JSON object per line, confirmed across all five fixtures.
2. **Per-event `type` discriminator?** YES — every event has `type`; many also have `subtype`.
3. **Tool calls radically different from `{"type":"tool_call","name":"...","arguments":{}}`?** NO — the shape is adapted, not radically different. There IS a `type:"tool_call"` family. The tool name is a wrapper key rather than a flat `name` field, and arguments are nested differently. This is a parser adaptation (use `Object.keys(tool_call)[0]` to get the name), not a rewrite of the architecture.
4. **Session id never appears in stream?** NO — `session_id` appears in `system/init` and every subsequent event.

**Conclusion: Phase 0 hard-gate NOT triggered. Phase 1 can proceed.**

Phase 2 Task 2.1 will adapt constants from master-design §8.2 names to actual names per the Deviations section above.

---

## Invocation corrections (affects Phase 1/2/4 plan code)

The plan recipe `cursor-agent -p "<prompt>" --output-format stream-json` is incorrect:

- `-p` / `--print` is a **boolean flag** (no argument).
- The prompt is a **positional argument**.
- `--force` is needed to bypass workspace-trust prompt on new/untrusted directories.

**Correct invocation:**
```bash
cursor-agent --print --output-format stream-json --force "<prompt>"
```

This affects:
- `scripts/dev/capture-fixture.sh` (bug fixed in this commit)
- Task 2.7 `scripts/lib/cursor.mjs` cursor invocation builder (CRITICAL — adapt before Phase 2)
- Task 1.4 setup smoke test (if it invokes cursor-agent)

Also note: `--trust` flag exists as an alternative to `--force` for headless workspace trust.

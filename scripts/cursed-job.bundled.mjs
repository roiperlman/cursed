#!/usr/bin/env node
import { createRequire as __cursedCreateRequire } from 'node:module';
const require = __cursedCreateRequire(import.meta.url);

// scripts/cursed-job.mjs
import { realpathSync } from "node:fs";
import { readFile as readFile4 } from "node:fs/promises";
import { join as join9, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// scripts/lib/run.mjs
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join as join7 } from "node:path";

// scripts/lib/prompt.mjs
import { readFile } from "node:fs/promises";
var VAR_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
function substitute(template, vars) {
  return template.replace(VAR_RE, (match, key) => {
    return Object.hasOwn(vars, key) ? String(vars[key]) : match;
  });
}
async function loadPrompt(path, vars) {
  const raw = await readFile(path, "utf8");
  return substitute(raw, vars);
}

// scripts/lib/watchdog.mjs
var Watchdog = class {
  /**
   * @param {ChildProcess} proc
   * @param {{ silenceMs: number; totalMs: number }} timeouts
   */
  constructor(proc, { silenceMs, totalMs }) {
    this.proc = proc;
    this.silenceMs = silenceMs;
    this.totalMs = totalMs;
    this._silenceT = null;
    this._totalT = null;
    this._killT = null;
    this._reason = null;
    this._resolve = null;
    this._done = false;
  }
  /**
   * Begin watching the child process. Resolves with the WatchdogResult once
   * the process exits (whether on its own or after a watchdog fire).
   *
   * @returns {Promise<WatchdogResult>}
   */
  run() {
    return new Promise((resolve2) => {
      this._resolve = resolve2;
      this.proc.once("exit", (code, signal) => {
        this._clearTimers();
        if (this._done) return;
        const reason = this._reason ?? (code === 0 && signal === null ? "completed" : "internal");
        this._finish({ reason, exitCode: code, signal });
      });
      this.proc.once("error", () => {
        this._clearTimers();
        if (this._done) return;
        this._finish({ reason: "internal", exitCode: null, signal: null });
      });
      this._resetSilence();
      this._totalT = setTimeout(() => this._fire("total_timeout"), this.totalMs);
    });
  }
  /** Reset the silence timer. Call from the stream parser on each line. */
  onEvent() {
    if (this._done) return;
    this._resetSilence();
  }
  /** Cancel the run from outside (e.g. user ^C). */
  cancel() {
    this._fire("cancelled");
  }
  _resetSilence() {
    if (this._silenceT) clearTimeout(this._silenceT);
    this._silenceT = setTimeout(() => this._fire("stall"), this.silenceMs);
  }
  _clearTimers() {
    if (this._silenceT) clearTimeout(this._silenceT);
    if (this._totalT) clearTimeout(this._totalT);
    if (this._killT) clearTimeout(this._killT);
    this._silenceT = this._totalT = this._killT = null;
  }
  /**
   * @param {ExitReason} reason
   */
  _fire(reason) {
    if (this._done || this._reason) return;
    this._reason = reason;
    this._clearTimers();
    try {
      this.proc.kill("SIGTERM");
    } catch {
    }
    this._killT = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
      }
    }, 5e3);
    this.proc.once("exit", (code, signal) => {
      if (this._done) return;
      this._finish({ reason: this._reason ?? reason, exitCode: code, signal });
    });
  }
  /**
   * @param {WatchdogResult} result
   */
  _finish(result) {
    if (this._done) return;
    this._done = true;
    this._clearTimers();
    if (this._resolve) this._resolve(result);
  }
};

// scripts/lib/adapters/registry.mjs
import { readFile as fsReadFile2 } from "node:fs/promises";

// scripts/lib/adapters/cursor/index.mjs
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// scripts/lib/adapters/cursor/args.mjs
var RESUME_FLAG = "--resume";
var CONTINUE_FLAG = "--continue";
function buildCursorArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  const args = ["--print", "--output-format", "stream-json", "--force", "--model", model];
  if (resumeSessionId) {
    args.push(RESUME_FLAG, resumeSessionId);
  } else if (resumeLast) {
    args.push(CONTINUE_FLAG);
  }
  args.push(prompt);
  return {
    command: "cursor-agent",
    args,
    env: { ...process.env, ...extraEnv }
  };
}

// scripts/lib/errors.mjs
var ERROR_CODES = Object.freeze({
  auth_failed: "auth_failed",
  not_installed: "not_installed",
  stall: "stall",
  total_timeout: "total_timeout",
  rate_limited: "rate_limited",
  network: "network",
  tool_refused: "tool_refused",
  cancelled: "cancelled",
  parse_error: "parse_error",
  session_invalid: "session_invalid",
  worktree_failed: "worktree_failed",
  worktree_branch_exists: "worktree_branch_exists",
  worktree_dir_exists: "worktree_dir_exists",
  worktree_cleanup_failed: "worktree_cleanup_failed",
  dirty_tree: "dirty_tree",
  stale: "stale",
  internal: "internal"
});
var EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  ALL_RUNS_FAILED: 1,
  CONFIG_ERROR: 2,
  AUTH_FAILURE: 3,
  NOT_INSTALLED: 4,
  JOB_STILL_RUNNING: 5,
  UNKNOWN_JOB: 6
});
function makeError(code, message, details) {
  if (!ERROR_CODES[code]) {
    throw new Error(`unknown error code: ${code}`);
  }
  const err = { code, message };
  if (details !== void 0) err.details = details;
  return err;
}

// scripts/lib/adapters/cursor/parse.mjs
var TYPE_SYSTEM_INIT = ["system", "init"];
var TYPE_ASSISTANT = ["assistant", null];
var TYPE_TOOL_CALL_STARTED = ["tool_call", "started"];
var TYPE_TOOL_CALL_DONE = ["tool_call", "completed"];
var TYPE_RESULT_SUCCESS = ["result", "success"];
var TYPE_RESULT_ERROR = ["result", "error"];
var FILE_WRITE_TOOLS = /* @__PURE__ */ new Set(["editToolCall", "writeToolCall", "createToolCall"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["shellToolCall"]);
function matchEvent(ev, [wantType, wantSub]) {
  if (ev.type !== wantType) return false;
  if (wantSub === null) return true;
  return ev.subtype === wantSub;
}
function emptyRun() {
  return {
    session_id: null,
    text: "",
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    errors: [],
    raw_event_count: 0
  };
}
function textFromContentBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
async function parseStream(raw) {
  const run = emptyRun();
  if (!raw) return run;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError("parse_error", `malformed JSON on line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    if (run.raw_event_count !== void 0) run.raw_event_count++;
    if (matchEvent(ev, TYPE_SYSTEM_INIT)) {
      if (ev.session_id) run.session_id = ev.session_id;
      continue;
    }
    if (matchEvent(ev, TYPE_ASSISTANT)) {
      run.text = textFromContentBlocks(ev.message?.content);
      if (ev.session_id && !run.session_id) run.session_id = ev.session_id;
      continue;
    }
    if (matchEvent(ev, TYPE_TOOL_CALL_DONE)) {
      const wrapper = ev.tool_call || {};
      const wrapperKey = Object.keys(wrapper)[0];
      if (!wrapperKey) continue;
      const payload = wrapper[wrapperKey] || {};
      if (FILE_WRITE_TOOLS.has(wrapperKey)) {
        const path = payload.args?.path;
        if (path && !run.files_changed.includes(path)) run.files_changed.push(path);
      } else if (SHELL_TOOLS.has(wrapperKey)) {
        const cmd = payload.args?.command;
        if (cmd) run.commands_run.push(String(cmd));
      }
      continue;
    }
    if (matchEvent(ev, TYPE_RESULT_SUCCESS) || matchEvent(ev, TYPE_RESULT_ERROR)) {
      if (ev.usage) {
        if (typeof ev.usage.inputTokens === "number") run.tokens.input = ev.usage.inputTokens;
        if (typeof ev.usage.outputTokens === "number") run.tokens.output = ev.usage.outputTokens;
        if (typeof ev.usage.cacheReadTokens === "number") run.tokens.cache_read = ev.usage.cacheReadTokens;
        if (typeof ev.usage.cacheWriteTokens === "number") run.tokens.cache_write = ev.usage.cacheWriteTokens;
      }
      if (ev.session_id && !run.session_id) run.session_id = ev.session_id;
      if (ev.subtype === "error" || ev.is_error) {
        const msg = typeof ev.result === "string" ? ev.result : "agent-reported error";
        run.errors.push(makeError("internal", msg));
      }
      continue;
    }
    void TYPE_TOOL_CALL_STARTED;
  }
  return run;
}
function streamEventLabel(line) {
  if (!line) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  if (matchEvent(ev, TYPE_SYSTEM_INIT)) {
    return { kind: "session_init", label: "session started" };
  }
  if (matchEvent(ev, TYPE_TOOL_CALL_STARTED)) {
    const wrapper = ev.tool_call || {};
    const wrapperKey = Object.keys(wrapper)[0] ?? "tool";
    return { kind: "tool_start", label: `tool: ${wrapperKey}` };
  }
  if (matchEvent(ev, TYPE_TOOL_CALL_DONE)) {
    return { kind: "tool_done", label: "tool done" };
  }
  if (matchEvent(ev, TYPE_ASSISTANT)) {
    return { kind: "assistant", label: "model responded" };
  }
  if (matchEvent(ev, TYPE_RESULT_SUCCESS)) {
    return { kind: "result", label: "completed" };
  }
  if (matchEvent(ev, TYPE_RESULT_ERROR)) {
    return { kind: "result_error", label: "agent error" };
  }
  return null;
}

// scripts/lib/adapters/cursor/probe.mjs
import { promisify } from "node:util";
import { exec as cpExec } from "node:child_process";
var defaultExec = promisify(cpExec);
async function defaultExecWrapped(cmd) {
  try {
    const { stdout, stderr } = await defaultExec(cmd);
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") throw e;
    const errAny = (
      /** @type {{ stdout?: string; stderr?: string; code?: number | string }} */
      e
    );
    return {
      stdout: errAny.stdout ?? "",
      stderr: errAny.stderr ?? "",
      exitCode: typeof errAny.code === "number" ? errAny.code : 1
    };
  }
}
async function defaultAuthCheck({ exec, env }) {
  if (env.CURSOR_API_KEY) return true;
  try {
    const { stdout, exitCode } = await exec("cursor-agent status");
    if (exitCode === 0 && /logged in/i.test(stdout || "")) return true;
  } catch {
  }
  return false;
}
async function probeSetup({ exec = defaultExecWrapped, env = process.env, authCheck = defaultAuthCheck } = {}) {
  const result = {
    available: false,
    version: null,
    authenticated: false,
    default_model: null,
    providers_reachable: [],
    warnings: [],
    errors: []
  };
  let versionOut;
  try {
    versionOut = await exec("cursor-agent --version");
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") {
      result.errors.push(makeError("not_installed", "cursor-agent not found on PATH"));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError("internal", `version probe failed: ${message}`));
    return result;
  }
  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError("not_installed", "cursor-agent not found on PATH"));
    return result;
  }
  result.available = true;
  result.version = (versionOut.stdout || "").trim().split("\n")[0] || null;
  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError("auth_failed", "no CURSOR_API_KEY and `cursor-agent status` does not report a logged-in session")
    );
  }
  return result;
}

// models.default.json
var models_default_default = {
  version: "1.3",
  updated_at: "2026-05-10",
  source_cursor_version: "2026.05.09-0afadcc",
  note: "Model IDs are from cursor-agent's real catalog (see docs/discovery-notes.md). Runtime-discoverable via `cursor-agent models`; this file is the static fallback for when discovery is unavailable (CI / offline). Update when Cursor's catalog changes. Anthropic models are intentionally absent from the `tiers` lists \u2014 cursed exists to widen the panel beyond Claude, so default selection picks non-Anthropic. They remain in `providers` so `--models claude-...` still works as an explicit invocation (resolveModels short-circuits explicit overrides regardless of tier membership).",
  tiers: {
    fast: ["composer-2-fast", "gpt-5.4-mini-medium", "gemini-3-flash"],
    balanced: ["composer-2", "gpt-5.4-medium"],
    reasoning: ["gpt-5.4-xhigh", "grok-4.3", "gemini-3.1-pro"]
  },
  providers: {
    cursor: ["composer-2-fast", "composer-2", "composer-1.5"],
    openai: ["gpt-5.4-xhigh", "gpt-5.4-medium", "gpt-5.4-mini-medium", "gpt-5.3-codex", "gpt-5.2"],
    anthropic: ["claude-opus-4-7-xhigh", "claude-4.6-sonnet-medium", "claude-4-sonnet", "claude-4.5-sonnet"],
    google: ["gemini-3-flash", "gemini-3.1-pro"],
    xai: ["grok-4.3"],
    moonshot: ["kimi-k2.5"]
  }
};

// scripts/lib/adapters/cursor/index.mjs
var VENDORS = Object.freeze(["cursor", "openai", "anthropic", "google", "xai", "moonshot"]);
function defaultCatalogPath() {
  return join(fileURLToPath(new URL("../../../../", import.meta.url)), "models.default.json");
}
var adapter = {
  name: "cursor",
  api_version: 1,
  vendors: [...VENDORS],
  buildArgs: buildCursorArgs,
  parseStream,
  probeSetup,
  defaultCatalogPath,
  catalog: models_default_default,
  streamEventLabel
};
var cursor_default = adapter;

// scripts/lib/adapters/codex/index.mjs
import os from "node:os";
import { join as join2 } from "node:path";

// scripts/lib/adapters/codex/args.mjs
var RESUME_SUBCOMMAND = "resume";
var RESUME_LAST_FLAG = "--last";
var BYPASS_SANDBOX_FLAG = "--dangerously-bypass-approvals-and-sandbox";
var SKIP_GIT_CHECK_FLAG = "--skip-git-repo-check";
function buildCodexArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  const args = ["exec"];
  if (resumeSessionId) {
    args.push(RESUME_SUBCOMMAND, resumeSessionId);
  } else if (resumeLast) {
    args.push(RESUME_SUBCOMMAND, RESUME_LAST_FLAG);
  }
  args.push("--json", "-m", model, SKIP_GIT_CHECK_FLAG, BYPASS_SANDBOX_FLAG);
  args.push(prompt);
  return {
    command: process.env.CURSED_CODEX_PATH || "codex",
    args,
    env: { ...process.env, ...extraEnv }
  };
}

// scripts/lib/adapters/codex/parse.mjs
var TYPE_THREAD_STARTED = "thread.started";
var TYPE_ITEM_STARTED = "item.started";
var TYPE_ITEM_COMPLETED = "item.completed";
var TYPE_TURN_COMPLETED = "turn.completed";
var TYPE_TURN_FAILED = "turn.failed";
var TYPE_ERROR = "error";
var ITEM_TYPE_AGENT_MESSAGE = "agent_message";
var ITEM_TYPE_COMMAND = "command_execution";
var ITEM_TYPE_FILE_CHANGE = "file_change";
function emptyRun2() {
  return {
    session_id: null,
    text: "",
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    errors: [],
    raw_event_count: 0
  };
}
async function parseStream2(raw) {
  const run = emptyRun2();
  if (!raw) return run;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError("parse_error", `malformed JSON on line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    if (run.raw_event_count !== void 0) run.raw_event_count++;
    switch (ev.type) {
      case TYPE_THREAD_STARTED: {
        if (typeof ev.thread_id === "string" && ev.thread_id) run.session_id = ev.thread_id;
        break;
      }
      case TYPE_ITEM_COMPLETED: {
        const item = ev.item || {};
        if (item.type === ITEM_TYPE_AGENT_MESSAGE) {
          if (typeof item.text === "string") run.text += item.text;
        } else if (item.type === ITEM_TYPE_COMMAND) {
          if (typeof item.command === "string" && item.command) {
            run.commands_run.push(item.command);
          }
        } else if (item.type === ITEM_TYPE_FILE_CHANGE) {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const c of changes) {
            const p = c && typeof c.path === "string" ? c.path : null;
            if (p && !run.files_changed.includes(p)) run.files_changed.push(p);
          }
        }
        break;
      }
      case TYPE_TURN_COMPLETED: {
        const u = ev.usage || {};
        if (typeof u.input_tokens === "number") run.tokens.input = u.input_tokens;
        if (typeof u.output_tokens === "number") run.tokens.output = u.output_tokens;
        if (typeof u.cached_input_tokens === "number") run.tokens.cache_read = u.cached_input_tokens;
        if (typeof u.reasoning_output_tokens === "number") run.tokens.reasoning = u.reasoning_output_tokens;
        break;
      }
      case TYPE_TURN_FAILED: {
        const msg = ev.error?.message;
        run.errors.push(makeError("internal", typeof msg === "string" && msg ? msg : "agent-reported error"));
        break;
      }
      case TYPE_ERROR: {
        const msg = typeof ev.message === "string" ? ev.message : "agent-reported error";
        run.errors.push(makeError("internal", msg));
        break;
      }
      default:
        break;
    }
  }
  return run;
}
function streamEventLabel2(line) {
  if (!line) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case TYPE_THREAD_STARTED:
      return { kind: "session_init", label: "session started" };
    case TYPE_ITEM_STARTED: {
      const itemType = ev.item?.type;
      if (!itemType || itemType === ITEM_TYPE_AGENT_MESSAGE) return null;
      return { kind: "tool_start", label: `tool: ${itemType}` };
    }
    case TYPE_ITEM_COMPLETED: {
      const itemType = ev.item?.type;
      if (itemType === ITEM_TYPE_AGENT_MESSAGE) {
        return { kind: "assistant", label: "model responded" };
      }
      if (!itemType) return null;
      return { kind: "tool_done", label: "tool done" };
    }
    case TYPE_TURN_COMPLETED:
      return { kind: "result", label: "completed" };
    case TYPE_TURN_FAILED:
    case TYPE_ERROR:
      return { kind: "result_error", label: "agent error" };
    default:
      return null;
  }
}

// scripts/lib/adapters/codex/probe.mjs
import { promisify as promisify2 } from "node:util";
import { exec as cpExec2 } from "node:child_process";
import { existsSync } from "node:fs";
var defaultExec2 = promisify2(cpExec2);
var DARWIN_BUNDLED_PATH = "/Applications/Codex.app/Contents/Resources/codex";
async function defaultExecWrapped2(cmd) {
  try {
    const { stdout, stderr } = await defaultExec2(cmd);
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") throw e;
    const errAny = (
      /** @type {{ stdout?: string; stderr?: string; code?: number | string }} */
      e
    );
    return {
      stdout: errAny.stdout ?? "",
      stderr: errAny.stderr ?? "",
      exitCode: typeof errAny.code === "number" ? errAny.code : 1
    };
  }
}
function resolveCodexCommand(env) {
  if (env.CURSED_CODEX_PATH) return env.CURSED_CODEX_PATH;
  if (process.platform === "darwin" && existsSync(DARWIN_BUNDLED_PATH)) {
  }
  return "codex";
}
async function defaultAuthCheck2({ exec, env }) {
  if (env.OPENAI_API_KEY) return true;
  const bin = resolveCodexCommand(env);
  try {
    const { stdout, stderr, exitCode } = await exec(`${bin} login status`);
    if (exitCode === 0 && /logged in/i.test((stdout || "") + (stderr || ""))) return true;
  } catch {
  }
  return false;
}
async function probeSetup2({ exec = defaultExecWrapped2, env = process.env, authCheck = defaultAuthCheck2 } = {}) {
  const result = {
    available: false,
    version: null,
    authenticated: false,
    default_model: null,
    // Phase 2 #3 will rename this to `vendors_reachable`; for now the field
    // stays compatible with the cursor adapter's shape.
    providers_reachable: [],
    warnings: [],
    errors: []
  };
  const bin = resolveCodexCommand(env);
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT" && bin === "codex" && process.platform === "darwin" && existsSync(DARWIN_BUNDLED_PATH)) {
      try {
        versionOut = await exec(`${DARWIN_BUNDLED_PATH} --version`);
      } catch {
        result.errors.push(makeError("not_installed", "codex not found on PATH or in /Applications/Codex.app"));
        return result;
      }
    } else if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") {
      result.errors.push(makeError("not_installed", `codex not found (looked for ${bin})`));
      return result;
    } else {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(makeError("internal", `version probe failed: ${message}`));
      return result;
    }
  }
  result.available = true;
  result.version = (versionOut.stdout || "").trim().split("\n")[0] || null;
  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError("auth_failed", "no OPENAI_API_KEY and `codex login status` does not report a logged-in session")
    );
  }
  return result;
}

// scripts/lib/adapters/codex/index.mjs
var VENDORS2 = Object.freeze(["openai"]);
function defaultCatalogPath2() {
  return join2(os.homedir(), ".codex", "models_cache.json");
}
var adapter2 = {
  name: "codex",
  api_version: 1,
  vendors: [...VENDORS2],
  buildArgs: buildCodexArgs,
  parseStream: parseStream2,
  probeSetup: probeSetup2,
  defaultCatalogPath: defaultCatalogPath2,
  streamEventLabel: streamEventLabel2
};
var codex_default = adapter2;

// scripts/lib/adapters/gemini/index.mjs
import { fileURLToPath as fileURLToPath2 } from "node:url";

// scripts/lib/adapters/gemini/args.mjs
var RESUME_FLAG2 = "--resume";
var RESUME_LATEST = "latest";
function buildGeminiArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  const args = ["-p", prompt, "-m", model, "-o", "stream-json", "--yolo", "--skip-trust"];
  if (resumeSessionId || resumeLast) {
    args.push(RESUME_FLAG2, RESUME_LATEST);
  }
  return {
    command: process.env.CURSED_GEMINI_PATH || "gemini",
    args,
    env: { ...process.env, ...extraEnv }
  };
}

// scripts/lib/adapters/gemini/parse.mjs
var TYPE_SESSION_STARTED = "init";
var TYPE_MESSAGE = "message";
var TYPE_TOOL_USE = "tool_use";
var TYPE_TOOL_RESULT = "tool_result";
var TYPE_ERROR2 = "error";
var TYPE_RESULT = "result";
var TOOL_SHELL = "run_shell_command";
var TOOL_WRITE = "write_file";
function emptyRun3() {
  return {
    session_id: null,
    text: "",
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    errors: [],
    raw_event_count: 0
  };
}
async function parseStream3(raw) {
  const run = emptyRun3();
  if (!raw) return run;
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    let _ev;
    try {
      _ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError("parse_error", `malformed JSON on line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    run.raw_event_count++;
    switch (_ev.type) {
      case TYPE_SESSION_STARTED: {
        const id = _ev.session_id;
        if (typeof id === "string" && id) run.session_id = id;
        break;
      }
      case TYPE_MESSAGE: {
        if (_ev.role !== "assistant") break;
        const text = typeof _ev.content === "string" ? _ev.content : null;
        if (text) run.text += text;
        break;
      }
      case TYPE_TOOL_USE: {
        const toolName = _ev.tool_name;
        if (toolName === TOOL_SHELL) {
          const cmd = _ev.parameters?.command;
          if (typeof cmd === "string" && cmd) run.commands_run.push(cmd);
        } else if (toolName === TOOL_WRITE) {
          const filePath = _ev.parameters?.file_path;
          if (typeof filePath === "string" && filePath && !run.files_changed.includes(filePath)) {
            run.files_changed.push(filePath);
          }
        }
        break;
      }
      case TYPE_RESULT: {
        const s = _ev.stats ?? {};
        const inputN = s.input_tokens;
        const outputN = s.output_tokens;
        const cacheReadN = s.cached;
        if (typeof inputN === "number") run.tokens.input = inputN;
        if (typeof outputN === "number") run.tokens.output = outputN;
        if (typeof cacheReadN === "number") run.tokens.cache_read = cacheReadN;
        if (_ev.status !== "success") {
          const msg = _ev.error?.message ?? _ev.message ?? "agent-reported error";
          run.errors.push(makeError("internal", typeof msg === "string" && msg ? msg : "agent-reported error"));
        }
        break;
      }
      case TYPE_ERROR2: {
        const msg = _ev.message ?? "agent-reported error";
        run.errors.push(makeError("internal", typeof msg === "string" && msg ? msg : "agent-reported error"));
        break;
      }
      default:
        void TYPE_TOOL_RESULT;
    }
  }
  return run;
}
function streamEventLabel3(line) {
  if (!line?.trim()) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case TYPE_SESSION_STARTED:
      return { kind: "session_init", label: "session started" };
    case TYPE_MESSAGE:
      if (ev.role !== "assistant") return null;
      return { kind: "assistant", label: "model responded" };
    case TYPE_TOOL_USE:
      return { kind: "tool_start", label: `tool: ${ev.tool_name ?? "tool"}` };
    case TYPE_TOOL_RESULT:
      return { kind: "tool_done", label: "tool done" };
    case TYPE_RESULT:
      return ev.status === "success" ? { kind: "result", label: "completed" } : { kind: "result_error", label: "agent error" };
    case TYPE_ERROR2:
      return { kind: "result_error", label: "agent error" };
    default:
      return null;
  }
}

// scripts/lib/adapters/gemini/probe.mjs
import { promisify as promisify3 } from "node:util";
import { exec as cpExec3 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";
var defaultExec3 = promisify3(cpExec3);
async function defaultExecWrapped3(cmd) {
  try {
    const { stdout, stderr } = await defaultExec3(cmd);
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") throw e;
    const errAny = (
      /** @type {{ stdout?: string; stderr?: string; code?: number | string }} */
      e
    );
    return {
      stdout: errAny.stdout ?? "",
      stderr: errAny.stderr ?? "",
      exitCode: typeof errAny.code === "number" ? errAny.code : 1
    };
  }
}
function resolveGeminiCommand(env) {
  return env.CURSED_GEMINI_PATH || "gemini";
}
var OAUTH_CREDS_PATH = join3(homedir(), ".gemini", "oauth_creds.json");
async function defaultAuthCheck3({ env }) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_API_KEY) return true;
  if (existsSync2(OAUTH_CREDS_PATH)) return true;
  return false;
}
async function probeSetup3({ exec = defaultExecWrapped3, env = process.env, authCheck = defaultAuthCheck3 } = {}) {
  const result = {
    available: false,
    version: null,
    authenticated: false,
    default_model: null,
    providers_reachable: [],
    warnings: [],
    errors: []
  };
  const bin = resolveGeminiCommand(env);
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") {
      result.errors.push(makeError("not_installed", `gemini not found (looked for ${bin})`));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError("internal", `version probe failed: ${message}`));
    return result;
  }
  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError("not_installed", `gemini --version exited ${versionOut.exitCode}`));
    return result;
  }
  result.available = true;
  result.version = (versionOut.stdout || "").trim().split("\n")[0] || null;
  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.errors.push(
      makeError(
        "auth_failed",
        "no GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY env var and ~/.gemini/oauth_creds.json not present"
      )
    );
  }
  return result;
}

// scripts/lib/adapters/gemini/catalog.json
var catalog_default = {
  version: "0.2",
  updated_at: "2026-05-20",
  note: "Static catalog of gemini-cli model slugs. gemini-cli has no runtime `models` subcommand; update this file when Google ships new model ids. Routing in adapterForModel uses the providers lists to dispatch slugs to the gemini adapter.",
  tiers: {
    fast: ["gemini-3-flash-preview"],
    balanced: ["gemini-3.1-pro-preview"],
    reasoning: ["gemini-3.1-pro-preview"]
  },
  providers: {
    google: [
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ]
  }
};

// scripts/lib/adapters/gemini/index.mjs
var VENDORS3 = Object.freeze(["google"]);
function defaultCatalogPath3() {
  return fileURLToPath2(new URL("./catalog.json", import.meta.url));
}
var adapter3 = {
  name: "gemini",
  api_version: 1,
  vendors: [...VENDORS3],
  buildArgs: buildGeminiArgs,
  parseStream: parseStream3,
  probeSetup: probeSetup3,
  defaultCatalogPath: defaultCatalogPath3,
  catalog: catalog_default,
  streamEventLabel: streamEventLabel3
};
var gemini_default = adapter3;

// scripts/lib/adapters/antigravity/index.mjs
import { fileURLToPath as fileURLToPath3 } from "node:url";

// scripts/lib/adapters/antigravity/args.mjs
function buildAntigravityArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  void model;
  const args = ["-p", prompt, "--dangerously-skip-permissions"];
  if (process.env.CURSED_ANTIGRAVITY_SANDBOX) args.push("--sandbox");
  if (resumeSessionId) {
    args.push("--conversation", resumeSessionId);
  } else if (resumeLast) {
    args.push("--continue");
  }
  return {
    command: process.env.CURSED_ANTIGRAVITY_PATH || "agy",
    args,
    env: { ...process.env, ...extraEnv }
  };
}

// scripts/lib/adapters/antigravity/parse.mjs
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
var TYPE_PLANNER_RESPONSE = "PLANNER_RESPONSE";
var TYPE_ERROR_MESSAGE = "ERROR_MESSAGE";
var TOOL_RUN_COMMAND = "run_command";
var ARG_COMMAND_LINE = "CommandLine";
var TOOL_WRITE_FILE = "write_to_file";
var ARG_FILE_PATH = "TargetFile";
function unquote(value) {
  if (typeof value !== "string") return "";
  let v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}
function emptyRun4() {
  return {
    session_id: null,
    text: "",
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    errors: [],
    raw_event_count: 0
  };
}
function parseTranscript(text, sessionId) {
  const run = emptyRun4();
  run.session_id = sessionId ?? null;
  if (!text) return run;
  const textParts = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError("parse_error", `malformed transcript line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    run.raw_event_count++;
    for (const tc of Array.isArray(ev.tool_calls) ? ev.tool_calls : []) {
      if (tc?.name === TOOL_RUN_COMMAND) {
        const cmd = unquote(tc.args?.[ARG_COMMAND_LINE]);
        if (cmd) run.commands_run.push(cmd);
      } else if (tc?.name === TOOL_WRITE_FILE) {
        const filePath = unquote(tc.args?.[ARG_FILE_PATH]);
        if (filePath && !run.files_changed.includes(filePath)) run.files_changed.push(filePath);
      }
    }
    if (ev.type === TYPE_PLANNER_RESPONSE && typeof ev.content === "string" && ev.content) {
      textParts.push(ev.content);
    }
    if (ev.type === TYPE_ERROR_MESSAGE) {
      const msg = typeof ev.content === "string" && ev.content ? ev.content : "agy step failed";
      run.errors.push(makeError("internal", msg));
    }
  }
  run.text = textParts.join("\n");
  return run;
}
async function parseStream4(raw, context = {}) {
  const { cwd, _readFile = fsReadFile, _homedir = homedir2 } = context;
  if (cwd) {
    try {
      const home = _homedir();
      const mapPath = join4(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json");
      const map = JSON.parse(await _readFile(mapPath, "utf8"));
      const convId = map[cwd];
      if (typeof convId === "string" && convId) {
        const transcriptPath = join4(
          home,
          ".gemini",
          "antigravity-cli",
          "brain",
          convId,
          ".system_generated",
          "logs",
          "transcript.jsonl"
        );
        const transcriptText = await _readFile(transcriptPath, "utf8");
        return parseTranscript(transcriptText, convId);
      }
    } catch {
    }
  }
  const run = emptyRun4();
  run.text = typeof raw === "string" ? raw.trim() : "";
  return run;
}
function streamEventLabel4(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  const label = trimmed.length > 80 ? `${trimmed.slice(0, 79)}\u2026` : trimmed;
  return { kind: "narration", label };
}

// scripts/lib/adapters/antigravity/probe.mjs
import { promisify as promisify4 } from "node:util";
import { exec as cpExec4 } from "node:child_process";
var defaultExec4 = promisify4(cpExec4);
async function defaultExecWrapped4(cmd) {
  try {
    const { stdout, stderr } = await defaultExec4(cmd);
    return { stdout, stderr, exitCode: 0 };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") throw e;
    const errAny = (
      /** @type {{ stdout?: string; stderr?: string; code?: number | string }} */
      e
    );
    return {
      stdout: errAny.stdout ?? "",
      stderr: errAny.stderr ?? "",
      exitCode: typeof errAny.code === "number" ? errAny.code : 1
    };
  }
}
function resolveAntigravityCommand(env) {
  return env.CURSED_ANTIGRAVITY_PATH || "agy";
}
async function defaultAuthCheck4({ exec }) {
  try {
    const r = await exec("security find-generic-password -s gemini -a antigravity");
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
async function probeSetup4({ exec = defaultExecWrapped4, env = process.env, authCheck = defaultAuthCheck4 } = {}) {
  const result = {
    available: false,
    version: null,
    authenticated: false,
    default_model: null,
    providers_reachable: [],
    warnings: [],
    errors: []
  };
  const bin = resolveAntigravityCommand(env);
  let versionOut;
  try {
    versionOut = await exec(`${bin} --version`);
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") {
      result.errors.push(makeError("not_installed", `agy not found (looked for ${bin})`));
      return result;
    }
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push(makeError("internal", `version probe failed: ${message}`));
    return result;
  }
  if (versionOut.exitCode !== 0) {
    result.errors.push(makeError("not_installed", `agy --version exited ${versionOut.exitCode}`));
    return result;
  }
  result.available = true;
  result.version = (versionOut.stdout || "").trim().split("\n")[0] || null;
  const authed = await authCheck({ exec, env });
  result.authenticated = authed;
  if (!authed) {
    result.warnings.push(
      "antigravity auth state could not be determined non-interactively; run `agy` once to sign in if runs fail with an auth error"
    );
  }
  return result;
}

// scripts/lib/adapters/antigravity/catalog.json
var catalog_default2 = {
  version: "0.1",
  updated_at: "2026-05-21",
  note: "agy has no per-run model flag; `antigravity-default` denotes the account-default model. Routing in adapterForModel uses the providers lists to dispatch this id to the antigravity adapter.",
  tiers: {
    fast: ["antigravity-default"],
    balanced: ["antigravity-default"],
    reasoning: ["antigravity-default"]
  },
  providers: {
    google: ["antigravity-default"]
  }
};

// scripts/lib/adapters/antigravity/index.mjs
var VENDORS4 = Object.freeze(["google"]);
function defaultCatalogPath4() {
  return fileURLToPath3(new URL("./catalog.json", import.meta.url));
}
var adapter4 = {
  name: "antigravity",
  api_version: 1,
  vendors: [...VENDORS4],
  buildArgs: buildAntigravityArgs,
  parseStream: parseStream4,
  probeSetup: probeSetup4,
  defaultCatalogPath: defaultCatalogPath4,
  catalog: catalog_default2,
  streamEventLabel: streamEventLabel4
};
var antigravity_default = adapter4;

// scripts/lib/adapters/contract.mjs
var NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
var REQUIRED_FUNCTIONS = (
  /** @type {const} */
  ["buildArgs", "parseStream", "probeSetup", "defaultCatalogPath"]
);
function validateAdapter(adapter5) {
  if (!adapter5 || typeof adapter5 !== "object") {
    throw new Error("adapter: must be a non-null object");
  }
  const a = (
    /** @type {Record<string, unknown>} */
    adapter5
  );
  const label = typeof a.name === "string" && a.name.length > 0 ? `adapter "${a.name}"` : "adapter";
  if (typeof a.name !== "string" || !NAME_PATTERN.test(a.name)) {
    throw new Error(`${label}: \`name\` must match ${NAME_PATTERN} (got ${JSON.stringify(a.name)})`);
  }
  if (a.api_version !== 1) {
    throw new Error(`${label}: \`api_version\` must be 1 (got ${JSON.stringify(a.api_version)})`);
  }
  if (!Array.isArray(a.vendors) || a.vendors.length === 0) {
    throw new Error(`${label}: \`vendors\` must be a non-empty string[]`);
  }
  for (const v of a.vendors) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${label}: \`vendors\` entries must be non-empty strings (got ${JSON.stringify(v)})`);
    }
  }
  if (new Set(a.vendors).size !== a.vendors.length) {
    throw new Error(`${label}: \`vendors\` contains duplicate entries`);
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof a[fn] !== "function") {
      throw new Error(`${label}: \`${fn}\` must be a function`);
    }
  }
}

// scripts/lib/adapters/registry.mjs
var ADAPTERS = Object.freeze({
  [cursor_default.name]: cursor_default,
  [codex_default.name]: codex_default,
  [gemini_default.name]: gemini_default,
  [antigravity_default.name]: antigravity_default
});
for (const a of Object.values(ADAPTERS)) validateAdapter(a);
function getAdapter(name = "cursor") {
  const a = ADAPTERS[name];
  if (!a) {
    const known = Object.keys(ADAPTERS).join(", ");
    throw new Error(`unknown adapter: "${name}" (registered: ${known})`);
  }
  return a;
}
async function adapterForModel(model, {
  _readFile = (
    /** @type {(path: string, encoding: string) => Promise<string>} */
    /** @type {unknown} */
    fsReadFile2
  )
} = {}) {
  try {
    const catalogPath = codex_default.defaultCatalogPath();
    const raw = await _readFile(catalogPath, "utf8");
    const catalog = JSON.parse(raw);
    const slugs = (catalog.models ?? []).map((m) => m.slug);
    if (slugs.includes(model)) return getAdapter("codex");
  } catch {
  }
  if (await catalogContains(gemini_default, model, _readFile)) return getAdapter("gemini");
  if (await catalogContains(antigravity_default, model, _readFile)) return getAdapter("antigravity");
  return getAdapter("cursor");
}
async function catalogContains(adapter5, model, _readFile) {
  if (adapter5.catalog) {
    const slugs = Object.values(adapter5.catalog.providers ?? {}).flat();
    return slugs.includes(model);
  }
  try {
    const raw = await _readFile(adapter5.defaultCatalogPath(), "utf8");
    const catalog = JSON.parse(raw);
    const slugs = Object.values(catalog.providers ?? {}).flat();
    return slugs.includes(model);
  } catch {
    return false;
  }
}

// scripts/lib/state.mjs
import { basename, resolve, join as join5 } from "node:path";
import { mkdir, readFile as readFile2, writeFile } from "node:fs/promises";
var DEFAULT_STATE = { version: 1, last_sessions: {} };
function stateFilePath(workspaceDirPath) {
  return join5(workspaceDirPath, "state.json");
}
async function readState(workspaceDirPath) {
  const path = stateFilePath(workspaceDirPath);
  try {
    const raw = await readFile2(path, "utf8");
    const s = JSON.parse(raw);
    return {
      version: s.version ?? 1,
      last_sessions: s.last_sessions ?? {}
    };
  } catch (e) {
    if (e instanceof Error && /** @type {NodeJS.ErrnoException} */
    e.code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }
    throw e;
  }
}
async function getLastSession(workspaceDirPath, command) {
  const s = await readState(workspaceDirPath);
  return s.last_sessions[command] ?? null;
}

// scripts/lib/transcripts.mjs
import { mkdir as mkdir2, appendFile, writeFile as writeFile2 } from "node:fs/promises";
import { join as join6 } from "node:path";
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
function dateParts(d) {
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  };
}
async function openTranscript(workspaceDir2, { command, model, now = /* @__PURE__ */ new Date() }) {
  const { date, time } = dateParts(now);
  const dir = join6(workspaceDir2, "runs", date);
  await mkdir2(dir, { recursive: true });
  const safeModel = String(model).replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join6(dir, `${time}-${command}-${safeModel}.jsonl`);
  return {
    path,
    async writeLine(line) {
      await appendFile(path, line.endsWith("\n") ? line : `${line}
`, "utf8");
    },
    async close() {
    }
  };
}

// scripts/lib/run.mjs
function pluginRoot() {
  const url = new URL("../..", import.meta.url);
  return decodeURIComponent(url.pathname);
}
async function runOne({
  command,
  model,
  tier,
  vars,
  resumeLast,
  timeouts,
  workspaceDir: wsDir,
  cwd,
  tee,
  onChildSpawned,
  notify,
  _spawn = spawn,
  _noAutoFallback = false
}) {
  const root = pluginRoot();
  const promptPath = join7(root, "prompts", `${command}.md`);
  const renderedPrompt = await loadPrompt(promptPath, vars ?? {});
  const transcript = await openTranscript(wsDir, { command, model });
  let resumeSessionId;
  let resumeLastForCursor = false;
  if (resumeLast) {
    const stored = await getLastSession(wsDir, command);
    if (stored) resumeSessionId = stored;
    else resumeLastForCursor = true;
  }
  const adapter5 = await adapterForModel(model);
  let progressN = 0;
  const tickProgress = (message) => {
    if (!notify) return;
    progressN += 1;
    try {
      notify.progress(progressN, void 0, message);
    } catch {
    }
  };
  const tickLog = (level, data) => {
    if (!notify) return;
    try {
      notify.log(level, data, "cursed.run");
    } catch {
    }
  };
  tickLog("info", { phase: "start", command, model, tier });
  tickProgress(`${command}: starting on ${model}`);
  const {
    command: cmd,
    args,
    env
  } = adapter5.buildArgs({
    prompt: renderedPrompt,
    model,
    resumeSessionId,
    resumeLast: resumeLastForCursor
  });
  const startedAt = Date.now();
  const proc = _spawn(cmd, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...cwd ? { cwd } : {}
  });
  if (onChildSpawned) onChildSpawned(proc);
  const teeStdout = tee ? createWriteStream(tee.stdoutPath, { flags: "a", encoding: "utf8" }) : null;
  const teeStderr = tee ? createWriteStream(tee.stderrPath, { flags: "a", encoding: "utf8" }) : null;
  if (teeStdout) teeStdout.on("error", () => {
  });
  if (teeStderr) teeStderr.on("error", () => {
  });
  const watchdog = new Watchdog(proc, {
    silenceMs: timeouts.silence_timeout_seconds * 1e3,
    totalMs: timeouts.total_timeout_seconds * 1e3
  });
  let rawBuffer = "";
  if (proc.stdout) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", async (chunk) => {
      rawBuffer += chunk;
      if (teeStdout) teeStdout.write(chunk);
      const lines = String(chunk).split("\n");
      for (const ln of lines) {
        const trimmed = ln.trim();
        if (trimmed === "") continue;
        watchdog.onEvent();
        if (notify && typeof adapter5.streamEventLabel === "function") {
          const labeled = adapter5.streamEventLabel(trimmed);
          if (labeled) tickProgress(`${model}: ${labeled.label}`);
        }
        await transcript.writeLine(ln).catch(() => {
        });
      }
    });
  }
  let stderrBuf = "";
  if (proc.stderr) {
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString("utf8");
      if (teeStderr) teeStderr.write(d);
    });
  }
  let watchResult;
  try {
    watchResult = await watchdog.run();
  } finally {
    await transcript.close();
    if (teeStdout) await new Promise((resolve2) => teeStdout.end(resolve2));
    if (teeStderr) await new Promise((resolve2) => teeStderr.end(resolve2));
  }
  const wallClockDurationMs = Date.now() - startedAt;
  const parsed = await adapter5.parseStream(rawBuffer, { cwd });
  const status = watchResult.reason === "completed" ? "completed" : "failed";
  const run = {
    model,
    tier,
    status,
    session_id: parsed.session_id,
    text: parsed.text,
    files_changed: parsed.files_changed,
    commands_run: parsed.commands_run,
    tokens: parsed.tokens,
    duration_ms: wallClockDurationMs,
    transcript_path: transcript.path,
    warnings: [],
    exit_reason: watchResult.reason
  };
  tickLog(status === "completed" ? "info" : "warning", {
    phase: "end",
    command,
    model,
    status,
    exit_reason: watchResult.reason,
    duration_ms: run.duration_ms
  });
  tickProgress(`${command}: ${status} (${watchResult.reason})`);
  if (status === "failed") {
    const first = parsed.errors[0];
    if (first) {
      run.error = first.details !== void 0 ? { code: first.code, message: first.message, details: first.details } : { code: first.code, message: first.message };
    } else {
      const stderrTail = stderrBuf.trim().slice(-500);
      const message = watchResult.reason === "internal" && stderrTail ? stderrTail : watchResult.reason;
      run.error = { code: watchResult.reason, message };
    }
    if (!_noAutoFallback && model !== "auto" && stderrBuf.includes("Named models unavailable")) {
      tickLog("warning", { phase: "auto-fallback", model, fallback: "auto" });
      return runOne({
        command,
        model: "auto",
        tier,
        vars,
        resumeLast,
        timeouts,
        workspaceDir: wsDir,
        cwd,
        tee,
        onChildSpawned,
        notify,
        _spawn,
        _noAutoFallback: true
      });
    }
  }
  return run;
}

// scripts/lib/jobs.mjs
import { dirname, join as join8 } from "node:path";
import { open, mkdir as mkdir3, readFile as readFile3, readdir, rename, rm, stat, access } from "node:fs/promises";
var atomicWriteCounter = 0n;
async function atomicWrite(target, content) {
  const tmp = `${target}.tmp.${process.pid}.${process.hrtime.bigint()}.${atomicWriteCounter++}`;
  let fh = null;
  try {
    fh = await open(tmp, "w");
    await fh.writeFile(content, "utf8");
    try {
      await fh.sync();
    } catch {
    }
  } finally {
    if (fh) await fh.close().catch(() => {
    });
  }
  await rename(tmp, target);
  try {
    const dirFh = await open(dirname(target), "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close().catch(() => {
      });
    }
  } catch {
  }
}
async function writeStatus(state_dir, status) {
  await atomicWrite(join8(state_dir, "status.json"), JSON.stringify(status, null, 2));
}
async function writeResult(state_dir, result) {
  try {
    await access(join8(state_dir, "result.json"));
    return { wrote: false };
  } catch {
  }
  await atomicWrite(join8(state_dir, "result.json"), JSON.stringify(result, null, 2));
  return { wrote: true };
}
async function cancelMarkerExists(state_dir) {
  try {
    await access(join8(state_dir, "cancel.marker"));
    return true;
  } catch {
    return false;
  }
}

// scripts/lib/git.mjs
import { execFile } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var pexec = promisify5(execFile);
async function gitStatusPorcelain(cwd = process.cwd()) {
  const { stdout } = await pexec("git", ["status", "--porcelain"], { cwd });
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  return { clean: lines.length === 0, lines };
}
async function gitWorktreeRemove(path, cwd = process.cwd()) {
  await pexec("git", ["worktree", "remove", "--force", path], { cwd });
}

// scripts/lib/worktree.mjs
async function removeWorktree({ path, repoRoot }) {
  await gitWorktreeRemove(path, repoRoot);
}
function relativeFromRepoRoot(path, repoRoot) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, "") : path;
}
async function runWorktreePostFlight({ worktreeInfo, runStatus, keep, repoRoot }) {
  const warnings = [];
  let cleanup_status;
  const wantCleanup = runStatus === "completed" && keep !== true;
  if (wantCleanup) {
    const wtStatus = await gitStatusPorcelain(worktreeInfo.path).catch(() => ({
      clean: true,
      lines: (
        /** @type {string[]} */
        []
      )
    }));
    if (!wtStatus.clean) {
      warnings.push(
        `worktree_uncommitted_output: model finished with ${wtStatus.lines.length} uncommitted entries in ${worktreeInfo.path}; worktree retained \u2014 inspect with \`cd ${worktreeInfo.path} && git status\``
      );
      cleanup_status = "kept-cleanup-failed";
    } else {
      try {
        await removeWorktree({ path: worktreeInfo.path, repoRoot });
        cleanup_status = "removed";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`worktree_cleanup_failed: ${msg}; worktree retained at ${worktreeInfo.path}`);
        cleanup_status = "kept-cleanup-failed";
      }
    }
  } else if (runStatus === "completed") {
    cleanup_status = "kept-on-success";
  } else {
    cleanup_status = "kept-due-to-failure";
  }
  const wtRel = relativeFromRepoRoot(worktreeInfo.path, repoRoot);
  const followup_commands = [
    `git diff ${worktreeInfo.base}..${worktreeInfo.branch}`,
    `git merge ${worktreeInfo.branch}`,
    ...cleanup_status === "removed" ? [] : [`git worktree remove ${wtRel}`],
    `git branch -d ${worktreeInfo.branch}`
  ];
  return { cleanup_status, warnings, followup_commands };
}

// scripts/cursed-job.mjs
function buildResult({ run, command, meta, postFlight, repoRoot }) {
  run.warnings = [...run.warnings, ...postFlight.warnings];
  const wtRel = relativeFromRepoRoot(meta.worktree.path, repoRoot);
  return {
    panel: false,
    command,
    run,
    selected_reason: `background-worker: tier=${meta.tier}, model=${meta.model}`,
    oc_context: null,
    worktree: {
      path: wtRel,
      branch: meta.worktree.branch,
      base: meta.worktree.base,
      cleanup_status: postFlight.cleanup_status,
      followup_commands: postFlight.followup_commands
    }
  };
}
function synthesizeInternalRun({ meta, err }) {
  return {
    model: meta.model,
    tier: meta.tier,
    status: "failed",
    session_id: null,
    text: "",
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    transcript_path: null,
    warnings: [],
    exit_reason: "internal",
    error: { code: "internal", message: err instanceof Error ? err.message : String(err) }
  };
}
async function writeWorkerInternalFailure({ state_dir, meta, err, repoRoot, postFlightFn }) {
  let postFlight = {
    cleanup_status: "kept-due-to-failure",
    followup_commands: [],
    warnings: [`worker internal failure: ${err instanceof Error ? err.message : String(err)}`]
  };
  try {
    postFlight = await postFlightFn({
      worktreeInfo: meta.worktree,
      runStatus: "failed",
      keep: meta.keep,
      repoRoot
    });
    postFlight.warnings.push(`worker internal failure: ${err instanceof Error ? err.message : String(err)}`);
  } catch {
  }
  try {
    const run = synthesizeInternalRun({ meta, err });
    const result = buildResult({ run, command: meta.command, meta, postFlight, repoRoot });
    await writeResult(state_dir, result);
  } catch {
  }
  try {
    await writeStatus(state_dir, {
      status: "failed",
      started_at: meta.started_at,
      finished_at: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch {
  }
}
async function runWorker({
  state_dir,
  repoRoot,
  _runOne = runOne,
  _runPostFlight = runWorktreePostFlight
}) {
  let meta;
  try {
    meta = JSON.parse(await readFile4(join9(state_dir, "meta.json"), "utf8"));
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    const finished_at = (/* @__PURE__ */ new Date()).toISOString();
    try {
      await writeStatus(state_dir, { status: "failed", started_at: finished_at, finished_at });
    } catch {
    }
    throw new Error(`worker: unreadable meta.json at ${state_dir}: ${msg}`);
  }
  const workspaceDir2 = dirname2(dirname2(state_dir));
  let procRef = null;
  let killedByCancel = false;
  let cancelPoll = setInterval(async () => {
    if (await cancelMarkerExists(state_dir)) {
      if (procRef && !killedByCancel) {
        killedByCancel = true;
        try {
          procRef.kill("SIGTERM");
        } catch {
        }
        setTimeout(() => {
          try {
            procRef?.kill("SIGKILL");
          } catch {
          }
        }, 5e3).unref();
      }
    }
  }, 1e3);
  try {
    let run;
    try {
      run = await _runOne({
        command: meta.command,
        model: meta.model,
        tier: meta.tier,
        vars: meta.vars,
        timeouts: {
          silence_timeout_seconds: meta.silence_timeout_seconds,
          total_timeout_seconds: meta.total_timeout_seconds
        },
        workspaceDir: workspaceDir2,
        cwd: meta.worktree.path,
        tee: { stdoutPath: join9(state_dir, "cursor.stdout"), stderrPath: join9(state_dir, "cursor.stderr") },
        onChildSpawned: (proc) => {
          procRef = proc;
        }
      });
    } catch (runErr) {
      if (cancelPoll) clearInterval(cancelPoll);
      cancelPoll = void 0;
      try {
        await writeStatus(state_dir, {
          status: "completing",
          started_at: meta.started_at,
          completing_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        const synth = synthesizeInternalRun({ meta, err: runErr });
        const postFlight2 = await _runPostFlight({
          worktreeInfo: meta.worktree,
          runStatus: "failed",
          keep: meta.keep,
          repoRoot
        });
        const result2 = buildResult({ run: synth, command: meta.command, meta, postFlight: postFlight2, repoRoot });
        await writeResult(state_dir, result2);
        await writeStatus(state_dir, {
          status: "failed",
          started_at: meta.started_at,
          finished_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        return;
      } catch {
        throw runErr;
      }
    }
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = void 0;
    await writeStatus(state_dir, {
      status: "completing",
      started_at: meta.started_at,
      completing_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    const runStatus = run.status === "completed" ? "completed" : "failed";
    const postFlight = await _runPostFlight({
      worktreeInfo: meta.worktree,
      runStatus,
      keep: meta.keep,
      repoRoot
    });
    const result = buildResult({ run, command: meta.command, meta, postFlight, repoRoot });
    await writeResult(state_dir, result);
    await writeStatus(state_dir, {
      status: killedByCancel || run.exit_reason === "cancelled" ? "cancelled" : runStatus,
      started_at: meta.started_at,
      finished_at: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (err) {
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = void 0;
    await writeWorkerInternalFailure({ state_dir, meta, err, repoRoot, postFlightFn: runWorktreePostFlight });
  }
}
function isEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath4(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  const state_dir = process.argv[2];
  if (!state_dir) {
    process.stderr.write("error: state_dir argument required\n");
    process.exit(2);
  }
  runWorker({ state_dir, repoRoot: process.cwd() }).then(() => process.exit(0)).catch((err) => {
    process.stderr.write(`worker fatal: ${err instanceof Error ? err.stack : String(err)}
`);
    process.exit(1);
  });
}
export {
  runWorker
};

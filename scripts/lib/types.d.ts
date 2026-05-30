/**
 * Shared type declarations for cursed.
 *
 * These types are referenced from multiple .mjs files. File-local types
 * remain inline as @typedef in the file that uses them.
 */

/* ──────────── Catalog and providers ──────────── */

/** Canonical default tiers. Catalogs may declare additional named tiers. */
export type Tier = "fast" | "balanced" | "reasoning";

/**
 * On-disk shape of `models.default.json` (plus the runtime-discovered shape
 * returned by `cursor-agent models`). Provider and tier keys are open strings
 * so new entries don't break parsing — narrow to ProviderId / Tier at use site.
 */
export interface Catalog {
  version: string;
  updated_at: string;
  note?: string;
  source_cursor_version?: string;
  tiers: Record<string, string[]>;
  providers: Record<string, string[]>;
  /**
   * Optional shorthand → canonical slug map. Used by `models_list` so the
   * worker can resolve user-supplied aliases (`grok`, `agy`, …) without
   * touching the prompt. Merged across enabled adapters with the same
   * first-occurrence-wins precedence as `tiers` and `providers`.
   */
  aliases?: Record<string, string>;
}

/**
 * One model as discovered by `Adapter.listModels`. The forward-compat shape
 * for runtime model discovery — see docs/adapters.md. Not yet emitted by any
 * adapter; `getModelSource` falls back to the static catalog when absent.
 */
export interface ModelInfo {
  slug: string;
  vendor: string;
  tier?: string;
}

/* ──────────── Run timeouts ──────────── */

/**
 * Timeouts the run pipeline expects. Field names match the TOML config
 * (CommandTimeoutConfig) so a per-command config block can be passed straight
 * through without a rename shim.
 */
export interface RunTimeouts {
  silence_timeout_seconds: number;
  total_timeout_seconds: number;
}

/* ──────────── Watchdog ──────────── */

/** Result of a Watchdog.run() — describes why the child process ended. */
export interface WatchdogResult {
  reason: ExitReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/* ──────────── Setup ──────────── */

/** Per-adapter probe results keyed by adapter name (e.g. "cursor", "codex"). */
export type AllAdaptersSetupResult = Record<string, SetupResult>;

/** Result of probing the local cursor-agent install for usability. */
export interface SetupResult {
  available: boolean;
  version: string | null;
  authenticated: boolean;
  default_model: string | null;
  providers_reachable: string[];
  warnings: string[];
  errors: CursedError[];
}

/* ──────────── Errors ──────────── */

/** Stable error code taxonomy (master-design §14). */
export type ErrorCode =
  | "auth_failed"
  | "not_installed"
  | "stall"
  | "total_timeout"
  | "rate_limited"
  | "network"
  | "tool_refused"
  | "cancelled"
  | "parse_error"
  | "session_invalid"
  | "worktree_failed"
  | "worktree_branch_exists"
  | "worktree_dir_exists"
  | "worktree_cleanup_failed"
  | "dirty_tree"
  | "stale"
  | "internal";

/** Structured error object returned by `makeError`. */
export interface CursedError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/* ──────────── Run config and results ──────────── */

export type CommandName = "advise" | "review" | "review-plan" | "delegate";

/** Outcome status of a single model run. */
export type RunStatus = "completed" | "failed";

/** Watchdog/exit reasons surfaced through the run pipeline. */
export type ExitReason =
  | "completed"
  | "stall"
  | "total_timeout"
  | "rate_limited"
  | "network"
  | "tool_refused"
  | "cancelled"
  | "auth_failed"
  | "session_invalid"
  | "internal";

/** Token usage counts reported by an adapter at end-of-stream. */
export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /**
   * Reasoning-output tokens billed separately from `output`. Codex emits this
   * via `usage.reasoning_output_tokens`; cursor has no equivalent and leaves
   * it unset. Optional so existing zero-valued cursor records remain valid
   * without a field on every object.
   */
  reasoning?: number;
}

/** Compact error pair stored on a RunRecord and aggregated in PanelSummary. */
export interface RunErrorPair {
  code: string;
  message: string;
  /** Carried through from CursedError when parseStream emitted a structured detail payload. */
  details?: Record<string, unknown>;
}

/**
 * One model run in the wire-format shape emitted by run.mjs / panel.mjs and
 * consumed by render.mjs and the MCP layer.
 */
export interface RunRecord {
  model: string;
  /** Name of the adapter that handled this run, matching `Adapter.name` (e.g. "cursor", "codex", "antigravity"). Resolved via `adapterForModel(model)`. */
  adapter: string;
  tier: Tier;
  status: RunStatus;
  session_id: string | null;
  text: string;
  files_changed: string[];
  commands_run: string[];
  tokens: TokenCounts;
  duration_ms: number;
  transcript_path: string | null;
  exit_reason: ExitReason | string;
  /** Non-fatal observations surfaced from pre-flight or post-flight (e.g. dirty-tree warning, cleanup failure). Defaults to []. */
  warnings: string[];
  error?: RunErrorPair;
}

/** Cleanup state for a worktree-isolated delegate run. */
export type WorktreeCleanupStatus =
  | "removed"
  | "kept-on-success"
  | "kept-due-to-failure"
  | "kept-cleanup-failed";

/** Worktree metadata attached to SoloRunResult when --worktree was used. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  base: string;
  cleanup_status: WorktreeCleanupStatus;
  followup_commands: string[];
}

/** Output of an adapter's `parseStream` — the partial run accumulated from the CLI's NDJSON. */
export interface ParsedRun {
  session_id: string | null;
  text: string;
  files_changed: string[];
  commands_run: string[];
  tokens: TokenCounts;
  /**
   * Zero-defaulted by parsers. `runOne` writes wall-clock duration into the
   * resulting `RunRecord.duration_ms` instead — the load-bearing value
   * surfaces there, not here. Kept as a (zero) field so callers that
   * round-trip ParsedRun through `renderSoloRun` still type-check; the
   * shim passes `RunRecord.duration_ms` through this slot.
   */
  duration_ms: number;
  errors: (CursedError | RunErrorPair)[];
  /** Total events seen on the stream. Optional — synthesized callers may omit it. */
  raw_event_count?: number;
}

/** One referenced path in the structural pre-pass result. */
export interface PrePassPathEntry {
  path: string;
  status: "present" | "missing" | "renamed_candidate";
  candidates?: string[];
}

/**
 * Deterministic structural pre-pass over the plan file.
 * Generated by `runStructuralPrePass` in `scripts/lib/plan-paths.mjs`.
 */
export interface PrePassResult {
  paths: PrePassPathEntry[];
  total: number;
  present: number;
  missing: number;
  renamed_candidate: number;
  warning: string | null;
}

/** Solo run wire format (single model). */
export interface SoloRunResult {
  panel: false;
  command: CommandName;
  run: RunRecord;
  selected_reason: string;
  oc_context: null;
  /** Non-null only when the call was invoked with `worktree: <name>`. */
  worktree: WorktreeInfo | null;
  /** Populated for `command === "review-plan"`. Null otherwise. */
  pre_pass?: PrePassResult | null;
}

/** Panel summary aggregated over N runs. */
export interface RunSummary {
  models_completed: number;
  models_failed: number;
  total_tokens: TokenCounts;
  total_duration_ms: number;
  errors: { model: string; code: string; message: string }[];
}

/** Panel run wire format (N models). */
export interface PanelResult {
  panel: true;
  command: CommandName;
  runs: RunRecord[];
  summary: RunSummary;
  transcript_aggregate_path: string | null;
  selected_reason: string;
  oc_context: null;
  /** Populated for `command === "review-plan"`. Null otherwise. */
  pre_pass?: PrePassResult | null;
}

/* ──────────── Config (TOML) shape ──────────── */

/** Per-command timeout settings. Structurally identical to RunTimeouts. */
export type CommandTimeoutConfig = RunTimeouts;

/** Panel sizing + model-selection settings keyed by command name. */
export interface PanelCommandConfig {
  panel_size: number;
  /** Tier override for this command. Falls back to `panel.tier`. */
  tier?: string;
  /** Vendor allowlist override. [] / undefined = inherit `panel.vendors`. */
  vendors?: string[];
  /** Adapter allowlist override. [] / undefined = inherit `panel.adapters`. */
  adapters?: string[];
}

/** Pre-flight policy for the `delegate` MCP tool when the working tree is dirty. */
export type DirtyTreeMode = "refuse" | "warn" | "allow";

/** Config block for background-mode delegate. */
export interface DelegateBackgroundConfig {
  /** Days a terminal/stale job directory is retained before GC removes it. */
  retention_days: number;
}

/** Config block for the `delegate` MCP tool. */
export interface DelegateConfig {
  dirty_tree: DirtyTreeMode;
  background: DelegateBackgroundConfig;
}

/** Adapter enablement + default-dispatch config. */
export interface AdaptersConfig {
  /** Adapter used for solo dispatch when the model does not pin one. */
  default: string;
  /** Adapters cursed may use. Others are ignored even if installed. */
  enabled: string[];
}

/**
 * Effective config shape after merge with defaults — what cursed code
 * consumes at runtime. Loaded from `<dataDir>/config.toml` (optional).
 */
export interface ConfigShape {
  defaults: CommandTimeoutConfig;
  commands: Record<string, CommandTimeoutConfig>;
  panel: {
    max_size: number;
    diversity: boolean;
    /** Default tier for panel/model selection. */
    tier: string;
    /** Default vendor allowlist. [] = all vendors. */
    vendors: string[];
    /** Default adapter allowlist. [] = all enabled adapters. */
    adapters: string[];
    commands: Record<string, PanelCommandConfig>;
  };
  adapters: AdaptersConfig;
  delegate: DelegateConfig;
}

/* ──────────── State (state.json) shape ──────────── */

/**
 * On-disk shape of `<workspaceDir>/state.json`. v0.2 of this shape carried a
 * placeholder `jobs: JobRecord[]` field reserved for background jobs; v0.3 #2
 * superseded it with the per-job-directory layout under `<workspaceDir>/jobs/<id>/`.
 * `readState` discards `jobs` if present in legacy files; `writeState` no longer emits it.
 */
export interface StateShape {
  version: 1;
  /** command name → most recent session id (or null when explicitly cleared). */
  last_sessions: Record<string, string | null>;
}

/* ──────────── Background jobs ──────────── */

/** Terminal status written by the worker (or synthesized by stale-detection). */
export type JobTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * Live-or-terminal status as recorded in `status.json`.
 *
 * `'completing'` is the short-lived state between `_runOne` returning and the
 * worker finishing `runWorktreePostFlight`. It exists so a reader that hits TTL
 * during post-flight does NOT synthesize a stale failure on top of an
 * otherwise-successful run. Treat `'completing'` as live (not subject to
 * stale-detection) but with no `result.json` yet guaranteed.
 */
export type JobStatus = "running" | "completing" | JobTerminalStatus;

/**
 * Immutable per-job metadata frozen at spawn time. Written to
 * `<workspaceDir>/jobs/<id>/meta.json` exactly once.
 */
export interface JobMeta {
  version: 1;
  id: string;
  command: CommandName;
  tier: Tier;
  model: string;
  vars: Record<string, unknown>;
  worktree: { path: string; branch: string; base: string };
  keep: boolean;
  started_at: string;
  silence_timeout_seconds: number;
  total_timeout_seconds: number;
  retention_days: number;
}

/** Live status record. Rewritten by the worker at terminal time. */
export interface JobStatusRecord {
  status: JobStatus;
  started_at: string;
  /** ISO timestamp recorded when the worker flipped to `'completing'`. Used by readJob to bound the post-flight grace window (COMPLETING_TTL_MS). */
  completing_at?: string;
  finished_at?: string;
}

/**
 * Worktree shape on `BackgroundJobHandle`. Distinct from `WorktreeInfo` for
 * two reasons:
 *
 *   1. `cleanup_status` is meaningless at spawn time — the worker hasn't run
 *      yet. The previous wire shape carried `cleanup_status: 'kept-on-success'`
 *      as a placeholder, which was actively misleading (a reader could
 *      conclude the worktree had already been retained due to success).
 *   2. `followup_commands` here are cursed slash-command pointers
 *      (`/cursed:status`, `/cursed:result`, …) rather than the git
 *      copy-paste commands `WorktreeInfo.followup_commands` carries.
 */
export interface BackgroundJobWorktree {
  path: string;
  branch: string;
  base: string;
  followup_commands: string[];
}

/** Wire shape returned by `delegate({ background: true })`. Mutually exclusive with `SoloRunResult` and `PanelResult`. */
export interface BackgroundJobHandle {
  background: true;
  command: CommandName;
  job_id: string;
  started_at: string;
  state_dir: string;
  status: "running";
  worktree: BackgroundJobWorktree;
}

/* ──────────── Adapter contract (Phase 1, cursor-only) ──────────── */

/**
 * Result of one `exec()` call inside an adapter probe. Matches today's
 * cursor probe shape so the existing fixture (`exec`/`env`/`authCheck`
 * injection in test/unit/setup.test.mjs) still works.
 */
export interface ProbeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Async `exec` wrapper accepted by an adapter probe. Test-injected in unit tests. */
export type ProbeExecFn = (cmd: string) => Promise<ProbeExecResult>;

/** Args passed to the auth-check callback during a probe. */
export interface ProbeAuthCheckArgs {
  exec: ProbeExecFn;
  env: NodeJS.ProcessEnv;
}

/** Auth-check callback. Adapters that don't need a separate auth probe can ignore. */
export type ProbeAuthCheckFn = (args: ProbeAuthCheckArgs) => Promise<boolean>;

/** Options every adapter's `probeSetup` accepts. */
export interface ProbeSetupOptions {
  exec?: ProbeExecFn;
  env?: NodeJS.ProcessEnv;
  authCheck?: ProbeAuthCheckFn;
}

/** Input to `adapter.buildArgs`. */
export interface BuildArgsInput {
  /** Final positional prompt argument passed to the CLI. */
  prompt: string;
  /** Model id, in the CLI's native naming. */
  model: string;
  /** When set, resume this exact session id. */
  resumeSessionId?: string;
  /** When true, resume the most recent session. */
  resumeLast?: boolean;
  /** Env overrides merged into the child env on top of process.env. */
  extraEnv?: Record<string, string | undefined>;
}

/** Output of `adapter.buildArgs`. Handed directly to `spawn(command, args, { env })`. */
export interface AdapterInvocation {
  /** Executable to spawn (e.g. "cursor-agent", "codex"). */
  command: string;
  /** Argv after the executable. */
  args: string[];
  /** Env for the child process. Adapters usually return `{...process.env, ...extraEnv}`. */
  env: Record<string, string | undefined>;
}

/**
 * Log level accepted by RunNotifier.log. Matches the MCP spec levels
 * (`debug | info | notice | warning | error | critical | alert | emergency`)
 * — only the four cursed actually emits are typed here; pass others as
 * strings if needed.
 */
export type RunNotifierLevel = "debug" | "info" | "notice" | "warning";

/**
 * Stream-emission hook threaded through `runOne` / `runSolo` / `runPanel`.
 * Implementations are typically MCP-server-backed (sendLoggingMessage +
 * notifications/progress). Sync signatures — implementations fire-and-forget
 * the underlying async sends and swallow errors so a misbehaving client
 * never breaks the in-flight tool call.
 *
 * Optional everywhere in the run pipeline; absent during CLI invocations
 * and unit tests by default.
 */
export interface RunNotifier {
  /** Emit a log message via MCP `notifications/message`. */
  log(level: RunNotifierLevel, data: unknown, logger?: string): void;
  /**
   * Emit a progress update via MCP `notifications/progress`. `total` is
   * optional — runOne doesn't know in advance how many stream events to
   * expect, so we typically omit it and treat `progress` as a free-running
   * counter.
   */
  progress(progress: number, total?: number, message?: string): void;
}

/**
 * Pluggable CLI adapter. The cursor adapter is the only implementation in
 * Phase 1; Phase 2 will add codex. Every entry in `adapters/registry.mjs`
 * must pass `validateAdapter` (see `adapters/contract.mjs`).
 *
 * `vendors` is declared today but not yet consumed by panel resolution;
 * Phase 2 wires panel resolution through the union of all adapter vendors.
 */
export interface Adapter {
  /** Stable identifier. Matches the directory name under `scripts/lib/adapters/`. */
  name: string;
  /** Adapter contract version. Bump on breaking changes to this interface. */
  api_version: 1;
  /** Model vendors reachable through this adapter. Single-vendor CLI → length 1; router → >1. */
  vendors: string[];
  /** Build the spawn invocation (command + args + env) for one model run. */
  buildArgs(input: BuildArgsInput): AdapterInvocation;
  /**
   * Parse the child's stdout into a partial run record. `context.cwd` is the
   * working directory the child ran in — adapters whose CLI writes a sidecar
   * transcript (antigravity) use it to locate that file; adapters that parse
   * stdout directly (cursor, codex, gemini) ignore it.
   */
  parseStream(raw: string | null | undefined, context?: { cwd?: string }): Promise<ParsedRun>;
  /** Probe whether the underlying CLI is installed and authenticated. */
  probeSetup(options?: ProbeSetupOptions): Promise<SetupResult>;
  /** Absolute path to the JSON catalog this adapter ships. */
  defaultCatalogPath(): string;
  /**
   * Optional. The static model catalog bundled with this adapter, imported as
   * a JSON module so the data is inlined into the esbuild bundle. Adapters
   * that ship a static catalog (cursor, gemini, antigravity) MUST set this:
   * `defaultCatalogPath()` resolves against `import.meta.url`, which no longer
   * points at the adapter's source directory once the server is bundled into
   * `scripts/mcp/cursed-mcp.bundled.mjs`. `getModelSource` prefers this field
   * over reading `defaultCatalogPath()` from disk. Adapters whose catalog is a
   * runtime cache (codex → `~/.codex/models_cache.json`) leave it unset.
   */
  catalog?: Catalog;
  /**
   * Optional. Discover the models this CLI can currently reach. When present,
   * `getModelSource` prefers it over `catalog` and `defaultCatalogPath()`. No
   * adapter implements this yet — declared so the resolver/setup path is
   * ready for it.
   */
  listModels?(): Promise<ModelInfo[]>;
  /**
   * Optional. Map one NDJSON line from the CLI's stdout to a short
   * `{kind, label}` if it's worth surfacing as an MCP progress event, or
   * `null` to ignore. Adapters that don't define this still get the
   * entry/exit emissions from runOne — they just don't emit per-event
   * progress mid-run.
   */
  streamEventLabel?(line: string): { kind: string; label: string } | null;
  /**
   * Optional. When true, the `review` MCP handler resolves the requested
   * `git diff` once at spawn time and inlines the result into the SCOPE
   * prompt variable. Default is `false`: Claude/Codex/Cursor get the diff
   * implicitly through their host harness, so SCOPE only needs to carry
   * the diff target. Adapters like Antigravity (`agy --print`) lack a host
   * harness — they would spend their `--print` window probing the
   * filesystem rather than fetching the diff — so they opt in here. Panel
   * resolution treats the flag as union-OR: if ANY selected adapter sets
   * `needsInlineDiff: true`, the diff is resolved once and shared across
   * the whole panel rather than per-model.
   */
  needsInlineDiff?: boolean;
}

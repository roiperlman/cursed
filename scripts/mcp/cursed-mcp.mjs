#!/usr/bin/env node
/**
 * cursed MCP server.
 *
 * Stdio-transport server declared in .claude-plugin/plugin.json. Tools
 * are a PRIVATE API — only the cursed-worker subagent should call them.
 *
 * Tool naming: registerTool('advise') ⇒ exposed as
 * mcp__plugin_cursed_cursed__advise by Claude Code (the `plugin_<plugin>_<server>__`
 * prefix is automatic; both plugin and server are named "cursed").
 */
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { probeAllAdapters } from '../lib/setup.mjs';
import { expandAdapterFilter } from '../lib/adapters/registry.mjs';
import { runSolo } from '../lib/run.mjs';
import { runPanel } from '../lib/panel.mjs';
import { loadCatalog, resolveModels, loadMergedCatalog } from '../lib/models.mjs';
import { loadConfig, resolveConfigPath, serializeConfig } from '../lib/config.mjs';
import { dataDir, workspaceDir } from '../lib/state.mjs';
import { gitStatusPorcelain } from '../lib/git.mjs';
import { createWorktree, runWorktreePostFlight, relativeFromRepoRoot } from '../lib/worktree.mjs';
import { makeError } from '../lib/errors.mjs';
import { gcWorkspaceJobs, writeStatus, writeResult } from '../lib/jobs.mjs';

/** @typedef {import("../lib/types.d.ts").ConfigShape} ConfigShape */
/** @typedef {import("../lib/types.d.ts").CommandName} CommandName */
/** @typedef {import("../lib/types.d.ts").RunTimeouts} RunTimeouts */

/**
 * @returns {string} Filesystem path to the cursed plugin root.
 */
function pluginRoot() {
  const url = new URL('../..', import.meta.url);
  return decodeURIComponent(url.pathname);
}

/**
 * Load the merged user config from disk.
 *
 * @returns {Promise<ConfigShape>}
 */
async function getConfig() {
  return loadConfig(resolveConfigPath());
}

/**
 * Build a RunTimeouts for the given command from cfg, falling back to defaults.
 *
 * @param {ConfigShape} cfg
 * @param {string} command
 * @returns {RunTimeouts}
 */
function timeoutsFor(cfg, command) {
  return { ...(cfg.commands[command] ?? cfg.defaults) };
}

/**
 * Wrap a JSON-able result in the MCP tool-response shape expected by the SDK.
 * Casts to `Record<string, unknown>` for `structuredContent` because the SDK's
 * CallToolResult type expects an open-loose object there; cursed result shapes
 * are structurally compatible but use literal narrowing that tsc rejects directly.
 *
 * @param {Record<string, unknown> | object} result
 * @returns {import("@modelcontextprotocol/sdk/types.js").CallToolResult}
 */
function structured(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: /** @type {Record<string, unknown>} */ (result),
  };
}

/**
 * Deep-merge a partial config onto a full ConfigShape. Arrays and scalars are
 * replaced wholesale; nested objects recurse. Used by config_apply.
 *
 * @param {Record<string, any>} base
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
function deepMergeConfig(base, patch) {
  /** @type {Record<string, any>} */
  const out = Array.isArray(base) ? /** @type {any} */ ([...base]) : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMergeConfig(/** @type {Record<string, any>} */ (out[k]), v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const panelCommandPartial = z
  .object({
    panel_size: z.number().int().positive().optional(),
    tier: z.string().optional(),
    vendors: z.array(z.string()).optional(),
    adapters: z.array(z.string()).optional(),
  })
  .strict();

const configPartialSchema = z
  .object({
    adapters: z
      .object({ default: z.string().optional(), enabled: z.array(z.string()).optional() })
      .strict()
      .optional(),
    defaults: z
      .object({
        silence_timeout_seconds: z.number().int().positive().optional(),
        total_timeout_seconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    commands: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    panel: z
      .object({
        max_size: z.number().int().positive().optional(),
        diversity: z.boolean().optional(),
        tier: z.string().optional(),
        vendors: z.array(z.string()).optional(),
        adapters: z.array(z.string()).optional(),
        commands: z.record(z.string(), panelCommandPartial).optional(),
      })
      .strict()
      .optional(),
    delegate: z
      .object({
        dirty_tree: z.enum(['refuse', 'warn', 'allow']).optional(),
        background: z.object({ retention_days: z.number().int().positive().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Test-only: captures the delegate handler so `__test_invokeDelegate__` can
 * invoke it directly without standing up an MCP transport.
 *
 * The hazard this state would otherwise create: concurrent `buildServer`
 * calls within the same process would each install their own handler
 * closure (different `handlerOverrides`), and the LAST call would overwrite
 * `__delegateHandlerRef.fn` — a parallel `__test_invokeDelegate__` from a
 * sibling test would then dispatch through the wrong overrides.
 *
 * Mitigated because:
 *   (a) production only calls `buildServer` once via `main()`; and
 *   (b) the `delegate-background.test.mjs` and `delegate-worktree.test.mjs`
 *       tests run in the forks pool (separate child processes per
 *       `vitest.config.mjs`), so cross-test interleaving is impossible.
 *
 * @type {{ fn: ((args: any, extra: any) => Promise<any>) | null }}
 */
const __delegateHandlerRef = { fn: null };

/**
 * Construct the cursed MCP server with all tool handlers registered.
 * Exported for unit tests.
 *
 * @param {{ overrides?: Record<string, unknown> }} [options]
 * @returns {McpServer}
 */
export function buildServer({ overrides } = { overrides: {} }) {
  const handlerOverrides = overrides ?? {};
  // Advertise `logging: {}` so server.sendLoggingMessage doesn't reject.
  // Claude Code as of 2.1.140 silently drops both `notifications/message`
  // and `notifications/progress` (see .cursed/spike-v2-findings.md), but
  // the wire frames are spec-compliant — if a future host release adds
  // rendering, every cursed call lights up retroactively with no producer-
  // side change. Cost: ~50 LOC + four lines in each handler. The protocol
  // guarantees that clients ignore notifications they don't understand,
  // so emitting to a non-rendering host is harmless.
  const server = new McpServer({ name: 'cursed', version: '0.2.0' }, { capabilities: { tools: {}, logging: {} } });

  /**
   * Build a RunNotifier from this server + a request handler's `extra`.
   * Closes over `server` so each handler can do `makeNotifier(extra)`.
   * Errors from the underlying SDK sends are swallowed — a misbehaving
   * client must never break a tool call.
   *
   * @param {any} extra - The request handler's `extra` arg.
   * @returns {import('../lib/types.d.ts').RunNotifier}
   */
  const makeNotifier = (extra) => {
    /** @type {string | number | undefined} */
    const progressToken = extra?._meta?.progressToken;
    /** @type {((n: any) => Promise<void>) | undefined} */
    const sendNotification = extra?.sendNotification;
    return {
      log(level, data, logger) {
        server.sendLoggingMessage({ level, data, logger }).catch(() => {});
      },
      progress(progress, total, message) {
        if (progressToken === undefined || !sendNotification) return;
        sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress, total, message },
        }).catch(() => {});
      },
    };
  };

  server.registerTool(
    'setup',
    {
      description:
        'Probe all CLI adapters (cursor-agent, codex) for installation and auth. Returns AllAdaptersSetupResult: a map of adapter name → SetupResult.',
      inputSchema: {},
    },
    async (_args, _extra) => {
      const result = await probeAllAdapters();
      return structured(result);
    },
  );

  server.registerTool(
    'config_get',
    {
      description:
        'Read the current merged cursed config plus the choices available for /cursed:setup. ' +
        'Returns { config: ConfigShape, path, exists, catalog: { tiers, vendors, adapters } }.',
      inputSchema: {},
    },
    async () => {
      const cfg = await getConfig();
      const path = resolveConfigPath();
      let exists = true;
      try {
        await access(path);
      } catch {
        exists = false;
      }
      const merged = await loadMergedCatalog(cfg.adapters.enabled);
      return structured({
        config: cfg,
        path,
        exists,
        catalog: {
          tiers: Object.keys(merged.tiers),
          vendors: Object.keys(merged.providers),
          adapters: cfg.adapters.enabled,
        },
      });
    },
  );

  server.registerTool(
    'config_apply',
    {
      description:
        'Merge a structured partial config onto the current config, validate it against ' +
        'the live catalog/registry, and write config.toml. Returns { ok, path, config, warnings }.',
      inputSchema: { config: configPartialSchema },
    },
    async ({ config: partial }) => {
      const current = await getConfig();
      const mergedObj = deepMergeConfig(current, partial);
      // Structural + adapter-name validation: serialize then re-parse through
      // loadConfig's mergeConfig, which throws `config error:` on bad input.
      const toml = serializeConfig(/** @type {ConfigShape} */ (mergedObj));
      const path = resolveConfigPath();
      const tmpPath = `${path}.tmp-${process.pid}`;
      await mkdir(dataDir(), { recursive: true });
      await writeFile(tmpPath, toml);
      let validated;
      try {
        validated = await loadConfig(tmpPath); // throws on structural / adapter-name errors
      } catch (e) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw new Error(`validation_error: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Semantic validation: every panel command's tier+filters resolves >= 1 model.
      /** @type {string[]} */
      const warnings = [];
      const catalog = await loadMergedCatalog(validated.adapters.enabled);
      for (const [cmd, pc] of Object.entries(validated.panel.commands)) {
        const tier = pc.tier ?? validated.panel.tier;
        if (!catalog.tiers[tier]) {
          warnings.push(`panel.commands.${cmd}: tier "${tier}" has no models in the enabled adapters`);
          continue;
        }
        const adapterVendors = expandAdapterFilter(pc.adapters ?? validated.panel.adapters);
        const vendorFilter = pc.vendors ?? validated.panel.vendors;
        const effective =
          adapterVendors.length && vendorFilter.length
            ? vendorFilter.filter((v) => adapterVendors.includes(v))
            : adapterVendors.length
              ? adapterVendors
              : vendorFilter;
        const size = pc.panel_size ?? 1;
        try {
          const got = resolveModels(catalog, { tier, count: size, vendors: effective });
          if (got.length < size) {
            warnings.push(
              `panel.commands.${cmd}: filters yield ${got.length} model(s) for panel_size ${size}`,
            );
          }
        } catch (e) {
          warnings.push(`panel.commands.${cmd}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Commit the validated file atomically.
      await writeFile(path, toml);
      await rm(tmpPath, { force: true }).catch(() => {});
      return structured({ ok: true, path, config: validated, warnings });
    },
  );

  server.registerTool(
    'advise',
    {
      description: 'Solo-only: ask a non-Claude model an open question. Returns SoloRunResult.',
      inputSchema: {
        question: z.string().min(1),
        context: z.string().optional(),
        tier: z.enum(['fast', 'balanced', 'reasoning']).optional(),
        models: z.array(z.string()).max(1).optional(),
        resume_last: z.boolean().optional(),
      },
    },
    async ({ question, context, tier, models, resume_last }, extra) => {
      const cfg = await getConfig();
      const explicit = Array.isArray(models) && models.length > 0 ? models : undefined;
      const result = await runSolo({
        command: 'advise',
        tier: tier ?? 'reasoning',
        vars: { QUESTION: question, CONTEXT: context ?? '' },
        explicitModels: explicit,
        resumeLast: resume_last === true,
        timeouts: timeoutsFor(cfg, 'advise'),
        notify: makeNotifier(extra),
      });
      return structured(result);
    },
  );

  server.registerTool(
    'review',
    {
      description:
        'Adversarial review of a diff. Panel-capable (1–3 models). Returns PanelResult or SoloRunResult discriminated by .panel.',
      inputSchema: {
        target: z.string().optional(),
        path: z.string().optional(),
        repo_guidance: z.string().optional(),
        panel_size: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        tier: z.enum(['balanced', 'reasoning']).optional(),
        models: z.array(z.string()).optional(),
        diversity: z.boolean().optional(),
        resume_last: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const cfg = await getConfig();
      const explicit = Array.isArray(args.models) && args.models.length > 0 ? args.models : undefined;
      const requestedSize = args.panel_size ?? cfg.panel.commands.review?.panel_size ?? 3;
      const panelSize = explicit ? explicit.length : Math.min(requestedSize, cfg.panel.max_size);

      if (panelSize > 1 && args.resume_last === true) {
        throw new Error('validation_error: resume_last is not supported when panel_size > 1');
      }

      const tier = args.tier ?? 'balanced';
      const diversity = args.diversity ?? cfg.panel.diversity;
      const vars = {
        SCOPE: args.path ? `path: ${args.path}` : `diff: ${args.target ?? 'main...HEAD'}`,
        REPO_GUIDANCE: args.repo_guidance ?? '',
      };

      const catalog = await loadCatalog(join(pluginRoot(), 'models.default.json'));
      const models = resolveModels(catalog, { tier, count: panelSize, diversity, explicit });
      const wsDir = workspaceDir();
      const selectedReason = explicit
        ? `panel=${models.length} explicit-models`
        : `panel=${models.length} tier=${tier} diversity=${diversity}`;

      const result = await runPanel({
        command: 'review',
        models,
        tier,
        vars,
        resumeLast: panelSize === 1 ? args.resume_last === true : false,
        timeouts: timeoutsFor(cfg, 'review'),
        workspaceDir: wsDir,
        selectedReason,
        notify: makeNotifier(extra),
      });
      return structured(result);
    },
  );

  server.registerTool(
    'plan_review',
    {
      description: 'Verify a plan against the code it claims to modify. Panel-capable (default solo).',
      inputSchema: {
        plan_path: z.string().min(1),
        code_paths: z.string().optional(),
        panel_size: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        tier: z.enum(['reasoning']).optional(),
        models: z.array(z.string()).optional(),
        diversity: z.boolean().optional(),
        resume_last: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const cfg = await getConfig();
      const explicit = Array.isArray(args.models) && args.models.length > 0 ? args.models : undefined;
      const requestedSize = args.panel_size ?? cfg.panel.commands.plan_review?.panel_size ?? 1;
      const panelSize = explicit ? explicit.length : Math.min(requestedSize, cfg.panel.max_size);

      if (panelSize > 1 && args.resume_last === true) {
        throw new Error('validation_error: resume_last is not supported when panel_size > 1');
      }

      const tier = args.tier ?? 'reasoning';
      const diversity = args.diversity ?? cfg.panel.diversity;
      const vars = {
        PLAN_PATH: args.plan_path,
        CODE_PATHS: args.code_paths ?? '',
      };

      const catalog = await loadCatalog(join(pluginRoot(), 'models.default.json'));
      const models = resolveModels(catalog, { tier, count: panelSize, diversity, explicit });
      const wsDir = workspaceDir();
      const selectedReason = explicit
        ? `panel=${models.length} explicit-models`
        : `panel=${models.length} tier=${tier} diversity=${diversity}`;

      // The MCP server runs in a workspace-stateless process; treat the
      // command alias for config lookup as 'plan-review' (with hyphen)
      // because COMMAND_OVERLAYS uses hyphenated keys for back-compat.
      const result = await runPanel({
        command: 'plan-review',
        models,
        tier,
        vars,
        resumeLast: panelSize === 1 ? args.resume_last === true : false,
        timeouts: timeoutsFor(cfg, 'plan-review'),
        workspaceDir: wsDir,
        selectedReason,
        notify: makeNotifier(extra),
      });
      return structured(result);
    },
  );

  const delegateHandler = async (/** @type {any} */ args, /** @type {any} */ extra) => {
    // Schema enforces models length ≤ 1; runtime check is belt-and-braces.
    if (Array.isArray(args.models) && args.models.length > 1) {
      throw new Error('validation_error: delegate is solo-only; pass at most one model name in `models`');
    }

    if (args.background === true && !args.worktree) {
      throw new Error('validation_error: background requires worktree (pass `worktree: <name>` alongside background)');
    }

    const cfg = await getConfig();
    const tier = args.tier ?? 'balanced';
    const repoRoot = process.cwd();

    /** @type {string | undefined} */
    let runCwd;
    /** @type {{ path: string, branch: string, base: string } | null} */
    let createdWt = null;
    /** @type {string[]} */
    const preflightWarnings = [];

    // Pre-flight ────────────────────────────────────────────────────────
    if (args.worktree) {
      // worktree path: dirty-tree check is skipped (worktree starts from a clean ref).
      try {
        createdWt = await createWorktree({
          name: args.worktree,
          base: args.base ?? 'HEAD',
          repoRoot,
        });
        runCwd = createdWt.path;
      } catch (err) {
        // Surface as MCP error so the SDK middleware returns isError=true.
        // createWorktree throws CursedError (plain object with .code/.message), not Error.
        const cursed = /** @type {{ code?: string; message?: string } | null} */ (
          err && typeof err === 'object' ? err : null
        );
        const message =
          err instanceof Error
            ? err.message
            : cursed?.code && cursed?.message
              ? `${cursed.code}: ${cursed.message}`
              : String(err);
        throw new Error(`runtime_error: ${message}`);
      }
    } else {
      // in-place path: consult dirty-tree policy.
      const status = await gitStatusPorcelain(repoRoot);
      if (!status.clean && args.allow_dirty !== true) {
        const mode = cfg.delegate.dirty_tree;
        if (mode === 'refuse') {
          const e = makeError(
            'dirty_tree',
            `working tree has uncommitted changes (${status.lines.length} entries); pass allow_dirty: true or use worktree`,
          );
          throw new Error(`runtime_error: ${e.code}: ${e.message}`);
        }
        if (mode === 'warn') {
          preflightWarnings.push(
            `dirty_tree: working tree has ${status.lines.length} uncommitted entries; delegate may clobber WIP`,
          );
        }
        // mode === 'allow' → no check, no warning
      }
    }

    // Background branch ─────────────────────────────────────────────────
    if (args.background === true && createdWt) {
      const { createJobState } = await import('../lib/jobs.mjs');
      const { spawn } = await import('node:child_process');

      const catalog = await loadCatalog(join(repoRoot, 'models.default.json')).catch(async () => {
        return loadCatalog(join(pluginRoot(), 'models.default.json'));
      });
      const explicit = Array.isArray(args.models) && args.models.length === 1 ? args.models : undefined;
      const [model] = resolveModels(catalog, { tier, count: 1, explicit });
      if (!model) {
        throw new Error(`validation_error: no models resolved for tier=${tier}`);
      }

      const wsDir = workspaceDir();
      const started_at = new Date().toISOString();
      const delegateTimeouts = timeoutsFor(cfg, 'delegate');
      /** @type {import('../lib/types.d.ts').JobMeta} */
      const meta = {
        version: 1,
        id: args.worktree,
        command: 'delegate',
        tier,
        model,
        vars: { TASK: args.task, REPO_GUIDANCE: args.repo_guidance ?? '' },
        worktree: { path: createdWt.path, branch: createdWt.branch, base: createdWt.base },
        keep: args.keep === true,
        started_at,
        silence_timeout_seconds: delegateTimeouts.silence_timeout_seconds,
        total_timeout_seconds: delegateTimeouts.total_timeout_seconds,
        retention_days: cfg.delegate.background.retention_days,
      };
      // Pre-spawn failure mode: if createJobState or anything below throws,
      // the worktree at createdWt.path leaks (no worker, no post-flight).
      // Recovery: `git worktree remove <path>` + `git branch -d <name>` manually.
      const { state_dir } = await createJobState({ workspaceDir: wsDir, id: args.worktree, meta });

      const workerFile = import.meta.url.endsWith('.bundled.mjs') ? 'cursed-job.bundled.mjs' : 'cursed-job.mjs';
      const workerPath = join(decodeURIComponent(new URL(`../${workerFile}`, import.meta.url).pathname));
      const spawnFn = /** @type {any} */ (handlerOverrides._spawn ?? spawn);
      // Open <state_dir>/worker.stderr append-only and hand the fd to the
      // spawn. Captures Node's own uncaught-exception trace if the worker
      // pipeline throws past the runWorker safety net (P4) — useful for
      // post-mortems since cursed never reads this file back. Best-effort:
      // if openSync fails (rare), fall back to /dev/null so we don't block
      // spawn on a forensic luxury.
      //
      // F7 (Gemini M3): try/finally so a synchronous throw from spawnFn
      // (invalid args, missing binary, test mocks) does not leak the fd.
      const { openSync, closeSync } = await import('node:fs');
      /** @type {number | 'ignore'} */
      let stderrFd = 'ignore';
      try {
        stderrFd = openSync(join(state_dir, 'worker.stderr'), 'a');
      } catch {
        stderrFd = 'ignore';
      }
      /** @type {ReturnType<typeof spawn>} */
      let child;
      try {
        child = spawnFn(process.execPath, [workerPath, state_dir], {
          detached: true,
          stdio: ['ignore', 'ignore', stderrFd],
          env: process.env,
          cwd: repoRoot,
        });
      } finally {
        // The parent doesn't need the fd open after spawn — the child
        // inherits its own clone. Close even when spawnFn threw.
        if (typeof stderrFd === 'number') {
          try {
            closeSync(stderrFd);
          } catch {
            /* already closed */
          }
        }
      }
      // ChildProcess emits `error` if the binary is missing or ENOENT. Node
      // emits the event on the next tick — the handler can't run inline with
      // the spawn, so the BackgroundJobHandle has already been returned to
      // the caller. The race window (Grok G3) is:
      //
      //   1. delegateHandler returns handle{status:'running'} to caller.
      //   2. ChildProcess fires 'error' on next tick.
      //   3. handler IIFE: writeResult(synth) → writeStatus('failed').
      //
      // Between (1) and (3) a hyper-fast caller can call /cursed:status and
      // see status='running' even though the spawn already failed. There's
      // no synchronous escape from this — the error event is async by
      // contract. We narrow the window by writing result.json FIRST and
      // status.json second; that way any caller that sees status='failed'
      // is guaranteed result.json is already on disk. Both writes use the
      // atomicWrite tmp+rename path so individual reads always see one
      // self-consistent file.
      //
      // The worktree at createdWt.path is intentionally left in place for
      // forensics (matches the T7 fix-up #3 convention) — manual recovery
      // via `git worktree remove <path>` is the documented path.
      child.on?.('error', (/** @type {unknown} */ err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`worker spawn error for ${args.worktree}: ${msg}\n`);
        // Best-effort: this handler is fire-and-forget — the
        // BackgroundJobHandle was already returned to the caller. Any
        // throw past these awaits is swallowed.
        (async () => {
          const finished_at = new Date().toISOString();
          /** @type {import('../lib/types.d.ts').SoloRunResult} */
          const synth = {
            panel: false,
            command: 'delegate',
            run: {
              model,
              tier,
              status: 'failed',
              session_id: null,
              text: '',
              files_changed: [],
              commands_run: [],
              tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
              duration_ms: 0,
              transcript_path: null,
              exit_reason: 'internal',
              warnings: [
                `worker_spawn_failed: ${msg}; worktree at ${createdWt.path} retained for forensics — remove via \`git worktree remove ${createdWt.path}\``,
              ],
              error: { code: 'internal', message: `worker spawn failed: ${msg}` },
            },
            selected_reason: `background-spawn-error: ${msg}`,
            oc_context: null,
            worktree: {
              path: createdWt.path,
              branch: createdWt.branch,
              base: createdWt.base,
              cleanup_status: 'kept-due-to-failure',
              followup_commands: [
                `git diff ${createdWt.base}..${createdWt.branch}`,
                `git worktree remove ${createdWt.path}`,
                `git branch -d ${createdWt.branch}`,
              ],
            },
          };
          // Write result FIRST: guarantees result.json exists before status flips,
          // so any reader that sees status='failed' can unconditionally read result.json.
          try {
            await writeResult(state_dir, synth);
          } catch {
            /* result.json conflict — leave existing */
          }
          // Flip status LAST so /cursed:status only advertises failure once result is readable.
          try {
            await writeStatus(state_dir, { status: 'failed', started_at, finished_at });
          } catch {
            /* nothing else we can do */
          }
        })();
      });
      child.unref?.();

      const wtRel = relativeFromRepoRoot(createdWt.path, repoRoot);
      /** @type {import('../lib/types.d.ts').BackgroundJobHandle} */
      const handle = {
        background: true,
        command: 'delegate',
        job_id: args.worktree,
        started_at,
        state_dir,
        status: 'running',
        worktree: {
          path: wtRel,
          branch: createdWt.branch,
          base: createdWt.base,
          // Slash-command pointers, not git commands. `cleanup_status` is
          // intentionally absent — see BackgroundJobWorktree JSDoc.
          followup_commands: [
            `/cursed:status ${args.worktree}`,
            `/cursed:cancel ${args.worktree}`,
            `/cursed:result ${args.worktree}`,
          ],
        },
      };
      return structured(handle);
    }

    // Run ───────────────────────────────────────────────────────────────
    /** @type {Awaited<ReturnType<typeof runSolo>>} */
    let result;
    try {
      result = await runSolo({
        command: 'delegate',
        tier,
        vars: { TASK: args.task, REPO_GUIDANCE: args.repo_guidance ?? '' },
        explicitModels: Array.isArray(args.models) && args.models.length === 1 ? args.models : undefined,
        resumeLast: false,
        timeouts: timeoutsFor(cfg, 'delegate'),
        cwd: runCwd,
        notify: makeNotifier(extra),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (createdWt) {
        // Preserve the worktree on throw (matches `kept-due-to-failure` semantic).
        // Surface the path so the user knows where to look.
        throw new Error(
          `runtime_error: runSolo failed mid-run: ${msg}. Worktree preserved at ${createdWt.path} on branch ${createdWt.branch}.`,
        );
      }
      throw err;
    }

    // Carry pre-flight warnings into the result.
    if (preflightWarnings.length > 0) {
      result.run.warnings = [...result.run.warnings, ...preflightWarnings];
    }

    // Post-flight (worktree only) ───────────────────────────────────────
    if (createdWt) {
      const pf = await runWorktreePostFlight({
        worktreeInfo: createdWt,
        runStatus: result.run.status,
        keep: args.keep === true,
        repoRoot,
      });
      result.run.warnings = [...result.run.warnings, ...pf.warnings];

      const wtRel = relativeFromRepoRoot(createdWt.path, repoRoot);
      result.worktree = {
        path: wtRel,
        branch: createdWt.branch,
        base: createdWt.base,
        cleanup_status: pf.cleanup_status,
        followup_commands: pf.followup_commands,
      };
    }

    return structured(result);
  };

  __delegateHandlerRef.fn = delegateHandler;

  server.registerTool(
    'delegate',
    {
      description:
        'Solo-only: hand a bounded task to a non-Claude model. Writes to current tree by default; pass `worktree` to isolate the run in a git worktree. Pass `background: true` (requires `worktree`) to detach and return a BackgroundJobHandle.',
      inputSchema: {
        task: z.string().min(1),
        repo_guidance: z.string().optional(),
        tier: z.enum(['balanced', 'reasoning']).optional(),
        models: z.array(z.string()).max(1).optional(),
        worktree: z.string().min(1).optional(),
        base: z.string().min(1).optional(),
        allow_dirty: z.boolean().optional(),
        keep: z.boolean().optional(),
        background: z.boolean().optional(),
      },
    },
    delegateHandler,
  );

  return server;
}

/**
 * One-shot lazy GC. Gated by `<dataDir>/last_gc.json` (~24h). Never throws.
 *
 * @param {{ dataDir: string, retentionDays: number, now: number }} input
 * @returns {Promise<{ ran: boolean, totalDeleted: number, warnings: string[] }>}
 */
export async function runStartupGC({ dataDir: ddir, retentionDays, now }) {
  const lgPath = join(ddir, 'last_gc.json');
  /** @type {string[]} */
  const warnings = [];
  /** @type {number | null} */
  let lastGc = null;
  try {
    const raw = await readFile(lgPath, 'utf8');
    const parsed = JSON.parse(raw);
    lastGc = Date.parse(parsed.last_gc);
    if (Number.isNaN(lastGc)) lastGc = null;
  } catch {
    /* no last_gc.json → run */
  }
  if (lastGc !== null && now - lastGc < 24 * 3600 * 1000) {
    return { ran: false, totalDeleted: 0, warnings: [] };
  }

  let totalDeleted = 0;
  try {
    const stateRoot = join(ddir, 'state');
    /** @type {string[]} */
    let workspaces = [];
    try {
      workspaces = await readdir(stateRoot);
    } catch (e) {
      if (e && /** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') {
        warnings.push(`readdir ${stateRoot}: ${String(e)}`);
      }
    }
    for (const ws of workspaces) {
      const wsPath = join(stateRoot, ws);
      const r = await gcWorkspaceJobs(wsPath, { retentionDays, now });
      totalDeleted += r.deleted.length;
      warnings.push(...r.warnings.map((w) => `${ws}: ${w}`));
    }
  } catch (e) {
    warnings.push(String(e));
  }
  try {
    await writeFile(lgPath, JSON.stringify({ last_gc: new Date(now).toISOString() }, null, 2), 'utf8');
  } catch (e) {
    warnings.push(`write last_gc.json: ${String(e)}`);
  }
  return { ran: true, totalDeleted, warnings };
}

/**
 * Stdio entry-point: build the server and connect a stdio transport.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Fire-and-forget GC after the server is live. A workspace with many job
  // dirs could make sequential `readJob` calls take seconds; running them
  // before `connect()` would make the MCP host see the server as slow to
  // start. `last_gc.json` only updates on completion, so a short-lived
  // server process simply retries on the next startup.
  void (async () => {
    try {
      const cfg = await loadConfig(join(dataDir(), 'config.toml'));
      const r = await runStartupGC({
        dataDir: dataDir(),
        retentionDays: cfg.delegate.background.retention_days,
        now: Date.now(),
      });
      if (r.warnings.length > 0) {
        for (const w of r.warnings) process.stderr.write(`gc warning: ${w}\n`);
      }
    } catch (e) {
      process.stderr.write(`gc skipped: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();
}

/**
 * Symlink-safe entry-point check: Claude Code installs plugins via a symlink
 * (e.g. `~/.claude/local-marketplace/plugins/cursed → repo root`), which causes
 * `import.meta.url` to resolve through the symlink while `process.argv[1]`
 * stays as the unresolved path. realpath both sides before comparing.
 *
 * @returns {boolean}
 */
function isEntrypoint() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((e) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`cursed-mcp fatal: ${detail}\n`);
    process.exit(1);
  });
}

/**
 * Test-only hook. Exercises the delegate handler with the same args shape
 * the MCP transport would deliver. Not part of the public API.
 *
 * @param {Record<string, unknown>} args
 * @param {{ _spawn?: Function }} [overrides]
 */
export async function __test_invokeDelegate__(args, overrides = {}) {
  buildServer({ overrides });
  if (!__delegateHandlerRef.fn) throw new Error('delegate not registered');
  const res = await __delegateHandlerRef.fn(args, {});
  return res.structuredContent ?? res;
}

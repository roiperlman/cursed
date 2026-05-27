#!/usr/bin/env node
import { parseArgs } from './lib/cli.mjs';
import { probeAllAdapters } from './lib/setup.mjs';
import { EXIT_CODES } from './lib/errors.mjs';

/** @typedef {import("./lib/types.d.ts").CommandName} CommandName */
/** @typedef {import("./lib/types.d.ts").RunTimeouts} RunTimeouts */
/** @typedef {import("./lib/types.d.ts").Tier} Tier */

/**
 * Coerce a flag value to a string, returning undefined for boolean/missing flags.
 *
 * @param {string | boolean | undefined} v
 * @returns {string | undefined}
 */
function flagString(v) {
  return typeof v === 'string' ? v : undefined;
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message}\n`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }

  switch (args.subcommand) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: case ends with process.exit() (noreturn — biome can't infer).
    case 'setup': {
      const result = await probeAllAdapters();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // Exit codes based on cursor (primary adapter) for backward compat.
      const cursor = result.cursor;
      if (cursor && !cursor.available) process.exit(EXIT_CODES.NOT_INSTALLED);
      if (cursor && !cursor.authenticated) process.exit(EXIT_CODES.AUTH_FAILURE);
      process.exit(EXIT_CODES.SUCCESS);
    }
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: case ends with process.exit() (noreturn — biome can't infer).
    case 'run': {
      const cmdName = flagString(args.flags.command);
      if (!cmdName) {
        process.stderr.write('error: --command is required\n');
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      const { runSolo } = await import('./lib/run.mjs');
      const { runPanel } = await import('./lib/panel.mjs');
      const { loadConfig } = await import('./lib/config.mjs');
      const { dataDir, workspaceDir } = await import('./lib/state.mjs');
      const { loadCatalog, resolveModels } = await import('./lib/models.mjs');
      const { runStructuralPrePass, renderPrePassSection } = await import('./lib/plan-paths.mjs');
      const { join } = await import('node:path');

      const cfg = await loadConfig(join(dataDir(), 'config.toml'));
      const cmdDefaults = cfg.commands[cmdName] ?? cfg.defaults;

      /** @type {Record<string, unknown>} */
      let vars = {};
      const varsFlag = flagString(args.flags.vars);
      if (varsFlag) {
        try {
          vars = JSON.parse(varsFlag);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          process.stderr.write(`error: --vars is not valid JSON: ${message}\n`);
          process.exit(EXIT_CODES.CONFIG_ERROR);
        }
      }

      const modelsFlag = flagString(args.flags.models);
      const explicitModels = modelsFlag ? modelsFlag.split(',') : undefined;
      const tier = /** @type {Tier} */ (flagString(args.flags.tier) ?? 'balanced');
      const resumeLast = args.flags['resume-last'] === true;
      /** @type {RunTimeouts} */
      const timeouts = {
        silence_timeout_seconds:
          Number(flagString(args.flags['silence-timeout'])) || cmdDefaults.silence_timeout_seconds,
        total_timeout_seconds: Number(flagString(args.flags['total-timeout'])) || cmdDefaults.total_timeout_seconds,
      };

      // Panel sizing: --solo wins, then --panel <N>, then config.
      // Clamp to cfg.panel.max_size.
      const cfgKey = cmdName.replace('-', '_'); // 'review-plan' → 'review_plan'
      const cfgPanelSize = cfg.panel.commands[cfgKey]?.panel_size ?? 1;
      let panelSize;
      if (args.flags.solo === true) {
        panelSize = 1;
      } else if (args.flags.panel !== undefined) {
        panelSize = Math.max(1, Number(flagString(args.flags.panel)) | 0);
      } else {
        panelSize = cfgPanelSize;
      }
      if (panelSize > cfg.panel.max_size) panelSize = cfg.panel.max_size;

      // Reject solo-only commands with panel > 1
      if (panelSize > 1 && (cmdName === 'advise' || cmdName === 'delegate')) {
        process.stderr.write(`error: ${cmdName} is solo-only in v0.2 (panel-${cmdName} is v0.3)\n`);
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }

      // Reject resume-last in panel mode
      if (panelSize > 1 && resumeLast) {
        process.stderr.write('error: --resume-last is not supported in panel mode (panel_size > 1)\n');
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }

      const command = /** @type {CommandName} */ (cmdName);

      // ROI-5: auto-attach STRUCTURAL_PRE_PASS for review-plan when caller
      // hasn't already provided it.
      /** @type {import('./lib/types.d.ts').PrePassResult | null} */
      let prePass = null;
      if (command === 'review-plan' && typeof vars.PLAN_PATH === 'string' && vars.STRUCTURAL_PRE_PASS === undefined) {
        prePass = await runStructuralPrePass({ planPath: vars.PLAN_PATH, repoRoot: process.cwd() });
        vars.STRUCTURAL_PRE_PASS = renderPrePassSection(prePass);
      }

      let result;
      if (panelSize === 1) {
        result = await runSolo({ command, tier, vars, explicitModels, resumeLast, timeouts });
      } else {
        const root = (() => {
          const u = new URL('..', import.meta.url);
          return decodeURIComponent(u.pathname);
        })();
        const catalog = await loadCatalog(join(root, 'models.default.json'));
        const models = resolveModels(catalog, {
          tier,
          count: panelSize,
          diversity: cfg.panel.diversity,
          explicit: explicitModels,
        });
        const wsDir = workspaceDir();
        const selectedReason = explicitModels
          ? `panel=${models.length} explicit-models`
          : `panel=${models.length} tier=${tier} diversity=${cfg.panel.diversity}`;
        result = await runPanel({
          command,
          models,
          tier,
          vars,
          resumeLast: false,
          timeouts,
          workspaceDir: wsDir,
          selectedReason,
        });
      }

      if (prePass) result.pre_pass = prePass;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const ok = result.panel ? result.summary.models_completed > 0 : result.run.status === 'completed';
      process.exit(ok ? EXIT_CODES.SUCCESS : EXIT_CODES.ALL_RUNS_FAILED);
    }
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: case ends with process.exit() (noreturn — biome can't infer).
    case 'jobs': {
      const action = args.positional[0];
      const id = args.positional[1];
      if (!['status', 'cancel', 'result', 'forget'].includes(action)) {
        process.stderr.write(
          `error: jobs action must be one of status|cancel|result|forget (got ${action ?? '<none>'})\n`,
        );
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      const { workspaceDir } = await import('./lib/state.mjs');
      const { listJobs, readJob, jobStateDir, writeCancelMarker, cancelMarkerExists, isJobLive } = await import(
        './lib/jobs.mjs'
      );
      const { rm } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const ws = workspaceDir();
      const asJson = args.flags.json === true;
      const timeoutSeconds = Number(flagString(args.flags['timeout-seconds'])) || 10;

      if (action === 'status' && !id) {
        const jobs = await listJobs(ws);
        const out = jobs.map((j) => ({
          id: j.id,
          status: j.status?.status ?? 'unreadable',
          started_at: j.meta?.started_at ?? null,
          model: j.meta?.model ?? null,
          warning: j.warning,
        }));
        if (asJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        else {
          if (out.length === 0) process.stdout.write('no jobs in this workspace\n');
          else {
            process.stdout.write(`${'ID'.padEnd(20)}  ${'STATUS'.padEnd(10)}  ${'MODEL'.padEnd(28)}  STARTED\n`);
            for (const j of out) {
              process.stdout.write(
                `${String(j.id).padEnd(20)}  ${String(j.status).padEnd(10)}  ${String(j.model ?? '-').padEnd(28)}  ${j.started_at ?? '-'}\n`,
              );
            }
          }
        }
        process.exit(EXIT_CODES.SUCCESS);
      }

      if (!id) {
        process.stderr.write(`error: jobs ${action} requires <id>\n`);
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      const sd = jobStateDir(ws, id);
      if (!existsSync(sd)) {
        process.stderr.write(`error: unknown job ${id}\n`);
        process.exit(EXIT_CODES.UNKNOWN_JOB);
      }
      const job = await readJob(sd);

      if (action === 'status') {
        const detail = {
          id,
          state_dir: sd,
          status: job.status.status,
          started_at: job.meta.started_at,
          finished_at: job.status.finished_at,
          model: job.meta.model,
          tier: job.meta.tier,
          worktree: job.meta.worktree,
        };
        if (asJson) process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
        else {
          for (const [k, v] of Object.entries(detail)) {
            process.stdout.write(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`);
          }
        }
        process.exit(EXIT_CODES.SUCCESS);
      }

      if (action === 'result') {
        // F12: result-presence-gated. If result.json exists on disk, print it
        // regardless of status.json — synthesizeStale (F5) can leave a job
        // with a real synthesized result.json but a stuck `running`/`completing`
        // status.json when writeStatus fails. Without this policy the user
        // could never retrieve the synthesized result. Only fall back to
        // "still running" / "missing result.json" when result is absent.
        if (job.result) {
          process.stdout.write(`${JSON.stringify(job.result, null, 2)}\n`);
          process.exit(EXIT_CODES.SUCCESS);
        }
        if (isJobLive(job.status.status)) {
          process.stderr.write(
            `error: job ${id} is still running; use /cursed:status to check, or /cursed:cancel to stop it\n`,
          );
          process.exit(EXIT_CODES.JOB_STILL_RUNNING);
        }
        process.stderr.write(`error: job ${id} is terminal but result.json is missing\n`);
        process.exit(EXIT_CODES.ALL_RUNS_FAILED);
      }

      if (action === 'cancel') {
        if (!isJobLive(job.status.status)) {
          if (job.result) {
            process.stdout.write(`${JSON.stringify(job.result, null, 2)}\n`);
            process.exit(EXIT_CODES.SUCCESS);
          }
          process.stdout.write(
            `${JSON.stringify({ status: job.status.status, started_at: job.meta.started_at, finished_at: job.status.finished_at, cancel_requested: false }, null, 2)}\n`,
          );
          process.exit(EXIT_CODES.SUCCESS);
        }
        if (!(await cancelMarkerExists(sd))) await writeCancelMarker(sd);
        const deadline = Date.now() + timeoutSeconds * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          /** @type {Awaited<ReturnType<typeof readJob>>} */
          let j2;
          try {
            j2 = await readJob(sd);
          } catch (e) {
            // gemini-3.1-pro panel-review-3 follow-up: a concurrent
            // /cursed:forget (or external rm) can delete the state dir
            // while we're polling. Pre-fix, readJob's meta-read threw
            // ENOENT and crashed the CLI with an unhandled promise
            // rejection. Emit a structured payload instead so client
            // scripts still get parseable JSON.
            const message = e instanceof Error ? e.message : String(e);
            process.stdout.write(
              `${JSON.stringify(
                { cancel_requested: true, gone: true, hint: `state dir disappeared during wait: ${message}` },
                null,
                2,
              )}\n`,
            );
            process.exit(EXIT_CODES.SUCCESS);
          }
          if (!isJobLive(j2.status.status)) {
            const payload = j2.result ?? {
              status: j2.status.status,
              started_at: j2.meta.started_at,
              finished_at: j2.status.finished_at,
            };
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
            process.exit(EXIT_CODES.SUCCESS);
          }
        }
        // Re-read after the timeout. Two cases:
        //   1. Job became terminal between the loop's last poll and this
        //      reread (TOCTOU window of ~1s). Emit the real result body so
        //      the user gets the same payload they would have seen on a
        //      clean loop exit — not a hint claiming result.json is missing
        //      when it isn't.
        //   2. Job is still live (running/completing). The cancel marker is
        //      down but the worker hasn't honored it yet; emit the timeout
        //      hint so the user knows to check back later.
        /** @type {Awaited<ReturnType<typeof readJob>>} */
        let jLast;
        try {
          jLast = await readJob(sd);
        } catch (e) {
          // gemini-3.1-pro panel-review-3 follow-up: same concurrent-rm
          // race as the loop body. The state dir can vanish in the gap
          // between the loop's last poll and this post-timeout reread.
          const message = e instanceof Error ? e.message : String(e);
          process.stdout.write(
            `${JSON.stringify(
              { cancel_requested: true, gone: true, hint: `state dir disappeared during wait: ${message}` },
              null,
              2,
            )}\n`,
          );
          process.exit(EXIT_CODES.SUCCESS);
        }
        if (!isJobLive(jLast.status.status)) {
          const payload = jLast.result ?? {
            status: jLast.status.status,
            started_at: jLast.meta.started_at,
            finished_at: jLast.status.finished_at,
          };
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          process.exit(EXIT_CODES.SUCCESS);
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              status: jLast.status.status,
              cancel_requested: true,
              hint: `worker did not write result.json within ${timeoutSeconds}s; check /cursed:status later`,
            },
            null,
            2,
          )}\n`,
        );
        process.exit(EXIT_CODES.SUCCESS);
      }

      if (action === 'forget') {
        if (isJobLive(job.status.status)) {
          process.stderr.write(`error: job ${id} is still running; cancel it before forgetting\n`);
          process.exit(EXIT_CODES.JOB_STILL_RUNNING);
        }
        await rm(sd, { recursive: true, force: true });
        process.stdout.write(`forgot ${id}\n`);
        process.exit(EXIT_CODES.SUCCESS);
      }
      process.exit(EXIT_CODES.CONFIG_ERROR);
    }
    default:
      process.stderr.write(`error: unknown subcommand "${args.subcommand}"\n`);
      process.exit(EXIT_CODES.CONFIG_ERROR);
  }
}

main().catch((e) => {
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.stderr.write(`internal error: ${detail}\n`);
  process.exit(EXIT_CODES.ALL_RUNS_FAILED);
});

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { loadPrompt } from './prompt.mjs';
import { Watchdog } from './watchdog.mjs';
import { adapterForModel } from './adapters/registry.mjs';
import { loadCatalog, resolveModels } from './models.mjs';
import { renderSoloRun } from './render.mjs';
import { workspaceDir, setLastSession, getLastSession } from './state.mjs';
import { openTranscript } from './transcripts.mjs';

/** @typedef {import("./types.d.ts").CommandName} CommandName */
/** @typedef {import("./types.d.ts").Tier} Tier */
/** @typedef {import("./types.d.ts").RunRecord} RunRecord */
/** @typedef {import("./types.d.ts").RunStatus} RunStatus */
/** @typedef {import("./types.d.ts").RunTimeouts} RunTimeouts */
/** @typedef {import("./types.d.ts").SoloRunResult} SoloRunResult */
/** @typedef {import("./types.d.ts").RunNotifier} RunNotifier */
/** @typedef {import("node:child_process").ChildProcess} ChildProcess */
/** @typedef {typeof spawn} SpawnFn */

/**
 * @returns {string} Filesystem path to the cursed plugin root (parent of `scripts/`).
 */
function pluginRoot() {
  const url = new URL('../..', import.meta.url);
  return decodeURIComponent(url.pathname);
}

/**
 * @typedef {object} RunOneInput
 * @property {CommandName} command
 * @property {string} model
 * @property {Tier} tier
 * @property {Record<string, unknown>} [vars]
 * @property {boolean} [resumeLast]
 * @property {RunTimeouts} timeouts
 * @property {string} workspaceDir - Per-workspace state dir (state.workspaceDir()).
 * @property {string} [cwd] - Working directory for the spawned cursor-agent. Defaults to process.cwd().
 * @property {{ stdoutPath: string, stderrPath: string }} [tee] - Mirror cursor-agent stdout/stderr to these paths. Background-job worker passes this; foreground runs do not.
 * @property {(proc: ChildProcess) => void} [onChildSpawned] - Called synchronously immediately after spawn; used by the background worker to capture proc for cancel-poll.
 * @property {RunNotifier} [notify] - Optional MCP-progress / logging hook. Absent for CLI invocations and most unit tests.
 * @property {SpawnFn} [_spawn] - Test injection point.
 * @property {boolean} [_noAutoFallback] - Internal: skip the "Named models unavailable" auto-fallback to prevent recursive retries.
 */

/**
 * Run one cursor-agent invocation against a single model.
 *
 * Returns the per-run shape (the inner `run` object of SoloRunResult, plus a `model`
 * field). Pure orchestration — no SoloRunResult/PanelResult wrapping.
 *
 * @param {RunOneInput} input
 * @returns {Promise<RunRecord>}
 */
export async function runOne({
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
  _noAutoFallback = false,
}) {
  const root = pluginRoot();
  const promptPath = join(root, 'prompts', `${command}.md`);
  const renderedPrompt = await loadPrompt(promptPath, vars ?? {});

  const transcript = await openTranscript(wsDir, { command, model });

  /** @type {string | undefined} */
  let resumeSessionId;
  let resumeLastForCursor = false;
  if (resumeLast) {
    const stored = await getLastSession(wsDir, command);
    if (stored) resumeSessionId = stored;
    else resumeLastForCursor = true;
  }

  // Resolve the adapter once per run: check the codex catalog for the model
  // slug; fall back to cursor when it's absent or the catalog is missing.
  const adapter = await adapterForModel(model);

  // Stream-emission counter. We don't know the total number of stage events
  // up front (cursor-agent decides), so progress is a free-running counter
  // and we omit `total` per MCP spec — see RunNotifier.progress.
  let progressN = 0;
  /** @param {string} message */
  const tickProgress = (message) => {
    if (!notify) return;
    progressN += 1;
    try {
      notify.progress(progressN, undefined, message);
    } catch {
      /* notify implementations are required to swallow internally, but
         guard the call site too so a buggy impl never breaks the run. */
    }
  };
  /** @param {'debug'|'info'|'notice'|'warning'} level @param {unknown} data */
  const tickLog = (level, data) => {
    if (!notify) return;
    try {
      notify.log(level, data, 'cursed.run');
    } catch {
      /* see tickProgress comment */
    }
  };

  tickLog('info', { phase: 'start', command, model, tier });
  tickProgress(`${command}: starting on ${model}`);
  const {
    command: cmd,
    args,
    env,
  } = adapter.buildArgs({
    prompt: renderedPrompt,
    model,
    resumeSessionId,
    resumeLast: resumeLastForCursor,
  });
  // Wall-clock baseline for run.duration_ms. Captured immediately before
  // spawn so it includes the child's startup overhead. Adapters' parsers
  // no longer surface duration — codex doesn't emit it, and tracking here
  // keeps both adapters symmetric.
  const startedAt = Date.now();
  const proc = _spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });

  // Background-mode hook: hand the child proc to the worker so it can SIGTERM on cancel.
  // Synchronous; throws here would abort the run.
  if (onChildSpawned) onChildSpawned(proc);

  // Tee: open WriteStreams once, close in finally. Errors are swallowed —
  // a failed tee must not abort a real run.
  const teeStdout = tee ? createWriteStream(tee.stdoutPath, { flags: 'a', encoding: 'utf8' }) : null;
  const teeStderr = tee ? createWriteStream(tee.stderrPath, { flags: 'a', encoding: 'utf8' }) : null;
  if (teeStdout) teeStdout.on('error', () => {});
  if (teeStderr) teeStderr.on('error', () => {});

  const watchdog = new Watchdog(proc, {
    silenceMs: timeouts.silence_timeout_seconds * 1000,
    totalMs: timeouts.total_timeout_seconds * 1000,
  });

  let rawBuffer = '';
  if (proc.stdout) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', async (chunk) => {
      rawBuffer += chunk;
      if (teeStdout) teeStdout.write(chunk);
      const lines = String(chunk).split('\n');
      for (const ln of lines) {
        const trimmed = ln.trim();
        if (trimmed === '') continue;
        // Sync operations FIRST so they fire deterministically per-event,
        // regardless of how long the transcript write takes. Without this
        // ordering, async I/O queued by the transcript write could delay
        // progress notifications past when runOne resolves — the host
        // would see only entry/exit emissions instead of per-event flow.
        watchdog.onEvent();
        // Optional adapter-provided per-line labeling. Adapters that don't
        // implement streamEventLabel get only the entry/exit emissions.
        // Partial-line events that span chunks fail to parse and return
        // null — we miss one progress tick, which is harmless.
        if (notify && typeof adapter.streamEventLabel === 'function') {
          const labeled = adapter.streamEventLabel(trimmed);
          if (labeled) tickProgress(`${model}: ${labeled.label}`);
        }
        await transcript.writeLine(ln).catch(() => {});
      }
    });
  }

  let stderrBuf = '';
  if (proc.stderr) {
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
      if (teeStderr) teeStderr.write(d);
    });
  }

  /** @type {Awaited<ReturnType<typeof watchdog.run>>} */
  let watchResult;
  try {
    watchResult = await watchdog.run();
  } finally {
    await transcript.close();
    if (teeStdout) await new Promise((resolve) => teeStdout.end(resolve));
    if (teeStderr) await new Promise((resolve) => teeStderr.end(resolve));
  }

  const wallClockDurationMs = Date.now() - startedAt;
  const parsed = await adapter.parseStream(rawBuffer, { cwd });
  /** @type {RunStatus} */
  const status = watchResult.reason === 'completed' ? 'completed' : 'failed';
  /** @type {RunRecord} */
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
    exit_reason: watchResult.reason,
  };
  tickLog(status === 'completed' ? 'info' : 'warning', {
    phase: 'end',
    command,
    model,
    status,
    exit_reason: watchResult.reason,
    duration_ms: run.duration_ms,
  });
  tickProgress(`${command}: ${status} (${watchResult.reason})`);

  if (status === 'failed') {
    const first = parsed.errors[0];
    if (first) {
      run.error =
        first.details !== undefined
          ? { code: first.code, message: first.message, details: first.details }
          : { code: first.code, message: first.message };
    } else {
      // When the child exits non-zero without emitting any stream events,
      // cursor-agent's real error (e.g. "Cannot use this model: ...") only
      // appears on stderr. Surface its tail so the failure is debuggable.
      const stderrTail = stderrBuf.trim().slice(-500);
      const message = watchResult.reason === 'internal' && stderrTail ? stderrTail : watchResult.reason;
      run.error = { code: watchResult.reason, message };
    }

    // cursor-agent free-plan fallback: named models fail with
    // "Named models unavailable". Retry once with --model auto so that
    // free-plan accounts can still complete tasks (auto picks the model).
    if (!_noAutoFallback && model !== 'auto' && stderrBuf.includes('Named models unavailable')) {
      tickLog('warning', { phase: 'auto-fallback', model, fallback: 'auto' });
      return runOne({
        command,
        model: 'auto',
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
        _noAutoFallback: true,
      });
    }
  }
  return run;
}

/**
 * @typedef {object} RunSoloInput
 * @property {CommandName} command
 * @property {Tier} tier
 * @property {Record<string, unknown>} [vars]
 * @property {string[]} [explicitModels]
 * @property {boolean} [resumeLast]
 * @property {RunTimeouts} timeouts
 * @property {string} [cwd] - Forwarded to runOne; cursor-agent spawn cwd.
 * @property {RunNotifier} [notify] - Optional MCP-progress / logging hook; forwarded to runOne.
 */

/**
 * Solo-mode entry retained for v0.1 backwards compatibility — accepts the
 * v0.1 named-arg shape and returns SoloRunResult. Internally delegates to
 * runOne and writes last_session on success. Panel-mode ships in
 * scripts/lib/panel.mjs.
 *
 * @param {RunSoloInput} input
 * @returns {Promise<SoloRunResult>}
 */
export async function runSolo({ command, tier, vars, explicitModels, resumeLast, timeouts, cwd, notify }) {
  const root = pluginRoot();
  const catalog = await loadCatalog(join(root, 'models.default.json'));
  const [model] = resolveModels(catalog, { tier, count: 1, explicit: explicitModels });
  if (!model) throw new Error(`no models resolved for tier=${tier}`);

  const wsDir = workspaceDir();
  const run = await runOne({ command, model, tier, vars, resumeLast, timeouts, workspaceDir: wsDir, cwd, notify });
  if (run.session_id) {
    await setLastSession(wsDir, command, run.session_id).catch(() => {});
  }
  return renderSoloRun({
    command,
    model,
    tier,
    parsed: {
      session_id: run.session_id,
      text: run.text,
      files_changed: run.files_changed,
      commands_run: run.commands_run,
      tokens: run.tokens,
      duration_ms: run.duration_ms,
      errors: run.error ? [run.error] : [],
    },
    transcriptPath: run.transcript_path,
    exitReason: run.exit_reason,
    selectedReason: `solo-mode v0.2: count=1, tier=${tier}`,
  });
}

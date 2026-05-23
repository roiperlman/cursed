import { runOne } from './run.mjs';
import { writePanelAggregate } from './transcripts.mjs';
import { setLastSession } from './state.mjs';
import { renderSoloRun } from './render.mjs';
import { adapterForModel } from './adapters/registry.mjs';

/** @typedef {import("./types.d.ts").CommandName} CommandName */
/** @typedef {import("./types.d.ts").Tier} Tier */
/** @typedef {import("./types.d.ts").RunRecord} RunRecord */
/** @typedef {import("./types.d.ts").RunSummary} RunSummary */
/** @typedef {import("./types.d.ts").RunTimeouts} RunTimeouts */
/** @typedef {import("./types.d.ts").SoloRunResult} SoloRunResult */
/** @typedef {import("./types.d.ts").PanelResult} PanelResult */
/** @typedef {import("./types.d.ts").TokenCounts} TokenCounts */

/**
 * Aggregate the per-run array into a PanelResult.summary object.
 *
 * @param {RunRecord[]} runs
 * @returns {RunSummary}
 */
function aggregate(runs) {
  const completed = runs.filter((r) => r.status === 'completed');
  const failed = runs.filter((r) => r.status !== 'completed');
  const total_tokens = runs.reduce(
    /**
     * @param {TokenCounts} acc
     * @param {RunRecord} r
     * @returns {TokenCounts}
     */
    (acc, r) => ({
      input: acc.input + (r.tokens?.input ?? 0),
      output: acc.output + (r.tokens?.output ?? 0),
      cache_read: acc.cache_read + (r.tokens?.cache_read ?? 0),
      cache_write: acc.cache_write + (r.tokens?.cache_write ?? 0),
    }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );
  const total_duration_ms = runs.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
  const errors = failed.map((r) => ({
    model: r.model,
    code: r.error?.code ?? r.exit_reason ?? 'internal',
    message: r.error?.message ?? r.exit_reason ?? 'unknown',
  }));
  return {
    models_completed: completed.length,
    models_failed: failed.length,
    total_tokens,
    total_duration_ms,
    errors,
  };
}

/**
 * @typedef {object} RunPanelInput
 * @property {CommandName} command
 * @property {string[]} models
 * @property {Tier} tier
 * @property {Record<string, unknown>} [vars]
 * @property {boolean} [resumeLast]
 * @property {RunTimeouts} timeouts
 * @property {string} workspaceDir
 * @property {string} selectedReason
 * @property {import('./types.d.ts').RunNotifier} [notify] - Optional MCP-progress / logging hook; forwarded to each runOne. Per-model emissions include the model name in the progress message, so panel members are distinguishable in the host UI.
 * @property {typeof runOne} [_runOne] - Test injection point.
 */

/**
 * runPanel — concurrent N-model orchestration via Promise.allSettled.
 *
 * Returns:
 *   - SoloRunResult shape (panel=false) when models.length === 1
 *   - PanelResult shape  (panel=true)  when models.length > 1
 *
 * Side effects:
 *   - Writes one transcript jsonl per model (via runOne)
 *   - Writes one PanelResult aggregate JSON when models.length > 1
 *   - Persists state.last_sessions[command] = lowest-indexed completed
 *     run's session_id (only when at least one completed)
 *
 * @param {RunPanelInput} input
 * @returns {Promise<SoloRunResult | PanelResult>}
 */
export async function runPanel({
  command,
  models,
  tier,
  vars,
  resumeLast,
  timeouts,
  workspaceDir,
  selectedReason,
  notify,
  _runOne = runOne,
}) {
  const settled = await Promise.allSettled(
    models.map((model) => _runOne({ command, model, tier, vars, resumeLast, timeouts, workspaceDir, notify })),
  );

  /** @type {RunRecord[]} */
  const runs = await Promise.all(
    settled.map(async (s, i) => {
      if (s.status === 'fulfilled') return s.value;
      // Synthesize a failed run object for a thrown rejection. Resolve the
      // adapter for the model so `run.adapter` is populated even on hard
      // failures — consumers (panel renderers, recipes, analytics) should
      // never see an undefined adapter.
      /** @type {{ message?: unknown }} */
      const reason = /** @type {{ message?: unknown }} */ (s.reason ?? {});
      const message = String(reason?.message || s.reason);
      let adapterName = 'unknown';
      try {
        adapterName = (await adapterForModel(models[i])).name;
      } catch {
        // adapterForModel can throw if no catalog matches and cursor isn't registered.
      }
      return {
        model: models[i],
        adapter: adapterName,
        tier,
        status: 'failed',
        session_id: null,
        text: '',
        files_changed: [],
        commands_run: [],
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        duration_ms: 0,
        transcript_path: null,
        warnings: [],
        exit_reason: 'internal',
        error: { code: 'internal', message },
      };
    }),
  );

  // Persist last_sessions: lowest-indexed completed run with a non-empty session_id.
  const winner = runs.find((r) => r.status === 'completed' && r.session_id);
  if (winner?.session_id) {
    await setLastSession(workspaceDir, command, winner.session_id).catch(() => {});
  }

  // SoloRunResult path
  if (models.length === 1) {
    const r = runs[0];
    return renderSoloRun({
      command,
      model: r.model,
      adapter: r.adapter,
      tier,
      parsed: {
        session_id: r.session_id,
        text: r.text,
        files_changed: r.files_changed,
        commands_run: r.commands_run,
        tokens: r.tokens,
        duration_ms: r.duration_ms,
        errors: r.error ? [r.error] : [],
      },
      transcriptPath: r.transcript_path,
      exitReason: r.exit_reason,
      selectedReason,
    });
  }

  // PanelResult path
  const summary = aggregate(runs);
  /** @type {PanelResult} */
  const panelResult = {
    panel: true,
    command,
    runs,
    summary,
    transcript_aggregate_path: null, // filled in below
    selected_reason: selectedReason,
    oc_context: null,
  };
  const aggregatePath = await writePanelAggregate(workspaceDir, { command, panelResult });
  panelResult.transcript_aggregate_path = aggregatePath;
  // Re-write with the path filled in so the on-disk aggregate is self-referential.
  await writePanelAggregate(workspaceDir, { command, panelResult });
  return panelResult;
}

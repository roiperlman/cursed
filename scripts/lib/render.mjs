/** @typedef {import("./types.d.ts").CommandName} CommandName */
/** @typedef {import("./types.d.ts").Tier} Tier */
/** @typedef {import("./types.d.ts").ExitReason} ExitReason */
/** @typedef {import("./types.d.ts").ParsedRun} ParsedRun */
/** @typedef {import("./types.d.ts").RunRecord} RunRecord */
/** @typedef {import("./types.d.ts").RunStatus} RunStatus */
/** @typedef {import("./types.d.ts").SoloRunResult} SoloRunResult */

/**
 * @typedef {object} RenderSoloRunInput
 * @property {CommandName} command
 * @property {string} model
 * @property {string} adapter
 * @property {Tier} tier
 * @property {ParsedRun} parsed
 * @property {string | null} transcriptPath
 * @property {ExitReason | string} exitReason
 * @property {string} selectedReason
 */

/**
 * Shape the final stdout JSON for a solo run per master design §7.3.
 * v0.1: panel: false always, oc_context: null always (v0.2).
 *
 * @param {RenderSoloRunInput} input
 * @returns {SoloRunResult}
 */
export function renderSoloRun({ command, model, adapter, tier, parsed, transcriptPath, exitReason, selectedReason }) {
  /** @type {RunStatus} */
  const status = exitReason === 'completed' ? 'completed' : 'failed';
  /** @type {RunRecord} */
  const run = {
    model,
    adapter,
    tier,
    status,
    session_id: parsed.session_id,
    text: parsed.text,
    files_changed: parsed.files_changed,
    commands_run: parsed.commands_run,
    tokens: parsed.tokens,
    duration_ms: parsed.duration_ms,
    transcript_path: transcriptPath,
    warnings: [],
    exit_reason: exitReason,
  };
  if (status === 'failed') {
    const first = parsed.errors[0];
    if (first) {
      run.error =
        first.details !== undefined
          ? { code: first.code, message: first.message, details: first.details }
          : { code: first.code, message: first.message };
    } else {
      run.error = { code: String(exitReason), message: String(exitReason) };
    }
  }
  return {
    panel: false,
    command,
    run,
    selected_reason: selectedReason,
    oc_context: null,
    worktree: null,
  };
}

/** @typedef {import("./types.d.ts").CommandName} CommandName */
/** @typedef {import("./types.d.ts").Tier} Tier */
/** @typedef {import("./types.d.ts").ExitReason} ExitReason */
/** @typedef {import("./types.d.ts").ParsedRun} ParsedRun */
/** @typedef {import("./types.d.ts").PanelResult} PanelResult */
/** @typedef {import("./types.d.ts").RunRecord} RunRecord */
/** @typedef {import("./types.d.ts").RunStatus} RunStatus */
/** @typedef {import("./types.d.ts").SoloRunResult} SoloRunResult */

/**
 * Adapter names panel render treats as known. Anything outside this set —
 * including the literal `"unknown"` sentinel panel.mjs writes when
 * `adapterForModel` throws — is treated as missing and renders without a
 * `[adapter]` tag so consumers fall back to the model id alone.
 *
 * Kept in sync by hand with `scripts/lib/adapters/registry.mjs`; the registry
 * is the source of truth for which adapters cursed ships. We don't import it
 * here because render.mjs is a pure shaper — no module-init side effects.
 */
const KNOWN_ADAPTERS = new Set(['cursor', 'codex', 'gemini', 'antigravity']);

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

/**
 * Format the adapter name for display next to a model id. Returns the bracketed
 * tag (e.g. `"[cursor]"`) for known adapters; returns `""` when the adapter is
 * missing, blank, or outside KNOWN_ADAPTERS so callers fall back to the bare
 * model id without throwing.
 *
 * @param {string | null | undefined} adapter
 * @returns {string}
 */
export function formatAdapterTag(adapter) {
  if (typeof adapter !== 'string') return '';
  const trimmed = adapter.trim();
  if (trimmed === '' || !KNOWN_ADAPTERS.has(trimmed)) return '';
  return `[${trimmed}]`;
}

/**
 * Format the heading label for one run: `"<model> [adapter]"` when the adapter
 * is known, `"<model>"` otherwise. Never throws on missing/unknown adapters.
 *
 * @param {Pick<RunRecord, "model" | "adapter">} run
 * @returns {string}
 */
export function formatRunHeading(run) {
  const tag = formatAdapterTag(run.adapter);
  return tag ? `${run.model} ${tag}` : run.model;
}

/**
 * Group runs by adapter, preserving first-appearance order both for adapter
 * names and the models inside each bucket. Unknown/missing adapters bucket
 * under the empty-string key so the caller can render them without a tag.
 *
 * @param {RunRecord[]} runs
 * @returns {{ adapter: string, tag: string, models: string[] }[]}
 */
function groupByAdapter(runs) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const r of runs) {
    const tag = formatAdapterTag(r.adapter);
    const key = tag ? r.adapter.trim() : '';
    const list = buckets.get(key);
    if (list) list.push(r.model);
    else buckets.set(key, [r.model]);
  }
  return Array.from(buckets, ([adapter, models]) => ({
    adapter,
    tag: adapter ? `[${adapter}]` : '',
    models,
  }));
}

/**
 * Render the adapter-grouped header line for a panel — the synthesized
 * "convergence/divergence by adapter" hint that lets a downstream LLM notice
 * patterns like "two cursor-routed models agree; antigravity diverges".
 *
 * Falls back to a model-only listing when no run has a known adapter, so the
 * line is informative without leaking the `unknown` sentinel.
 *
 * @param {RunRecord[]} runs
 * @returns {string}
 */
export function renderAdapterSummary(runs) {
  if (runs.length === 0) return '';
  const groups = groupByAdapter(runs);
  const named = groups.filter((g) => g.adapter !== '');
  const unnamed = groups.find((g) => g.adapter === '');
  /** @type {string[]} */
  const parts = [];
  for (const g of named) {
    parts.push(`${g.models.length}/${runs.length} ${g.adapter}-routed (${g.models.join(', ')})`);
  }
  if (unnamed) {
    parts.push(`${unnamed.models.length}/${runs.length} adapter-unknown (${unnamed.models.join(', ')})`);
  }
  return `By adapter: ${parts.join('; ')}`;
}

/**
 * Render one PanelResult to user-facing markdown.
 *
 * Output shape (consumed by `commands/review.md` and any future caller that
 * wants a canonical text rendering):
 *
 *   ## Panel: <command> (N models, completed/N completed)
 *   <adapter summary line>
 *
 *   ### <model> [adapter]
 *   <run.text or failure note>
 *
 *   ...
 *
 * Robust when `RunRecord.adapter` is missing/unknown: the heading omits the
 * tag rather than throwing or printing a meaningless `[unknown]` marker.
 *
 * @param {PanelResult} panel
 * @returns {string}
 */
export function renderPanel(panel) {
  const total = panel.runs.length;
  const completed = panel.summary?.models_completed ?? panel.runs.filter((r) => r.status === 'completed').length;
  /** @type {string[]} */
  const lines = [];
  lines.push(`## Panel: ${panel.command} (${total} models, ${completed}/${total} completed)`);
  const summary = renderAdapterSummary(panel.runs);
  if (summary) {
    lines.push('');
    lines.push(summary);
  }
  for (const r of panel.runs) {
    lines.push('');
    const heading = formatRunHeading(r);
    if (r.status === 'completed') {
      lines.push(`### ${heading}`);
    } else {
      const code = r.error?.code ?? r.exit_reason ?? 'failed';
      const message = r.error?.message ?? String(r.exit_reason ?? 'failed');
      lines.push(`### ${heading} — failed (${code}: ${message})`);
    }
    lines.push('');
    lines.push(r.text && r.text.length > 0 ? r.text : '_(no output)_');
  }
  return lines.join('\n');
}

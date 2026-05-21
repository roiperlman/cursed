import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").ParsedRun} ParsedRun */
/** @typedef {import("../../types.d.ts").TokenCounts} TokenCounts */

// Event type discriminators observed in `codex exec --json` output as of
// codex-cli 0.130.0-alpha.5. See `.cursed/codex-discovery.md` for the
// cursor↔codex "same/different" tables and `test/fixtures/streams/codex/`
// for captured examples.
const TYPE_THREAD_STARTED = 'thread.started'; // session start
// turn.started is observed on every turn but ignored — no ParsedRun
// mutations and not surfaced as MCP progress (no useful label).
const TYPE_ITEM_STARTED = 'item.started'; // tool started / message starting
const TYPE_ITEM_COMPLETED = 'item.completed'; // tool result OR agent message
const TYPE_TURN_COMPLETED = 'turn.completed'; // turn end (ok) — has `usage`
const TYPE_TURN_FAILED = 'turn.failed'; // turn end (err) — has `error.message`
const TYPE_ERROR = 'error'; // mid-stream error preceding turn.failed

// Item types nested under item.{started,completed}.item.type. The discriminator
// lives on `item.type` rather than wrapper keys (cursor uses wrapper keys).
const ITEM_TYPE_AGENT_MESSAGE = 'agent_message';
const ITEM_TYPE_COMMAND = 'command_execution';
const ITEM_TYPE_FILE_CHANGE = 'file_change'; // confirmed in file-edit.jsonl fixture

/**
 * @returns {Required<ParsedRun>}
 */
function emptyRun() {
  return {
    session_id: null,
    text: '',
    files_changed: [],
    commands_run: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    duration_ms: 0,
    errors: [],
    raw_event_count: 0,
  };
}

/**
 * Parse a `codex exec --json` transcript into a ParsedRun.
 *
 * Notes:
 *  - `run.duration_ms` is left at 0; runOne owns wall-clock duration.
 *  - `agent_message` items can fire multiple times per turn. We concat their
 *    `text` in stream order — preserves narrative across interleaved tool
 *    calls (decision recorded in `.cursed/codex-discovery.md` Gap 3).
 *  - `file_change.item.changes` is an array of `{ path, kind }`; we collect
 *    every distinct path. Cursor's parser ignores kind too.
 *  - codex emits `usage.cached_input_tokens` (singular field, sums prompt-side
 *    cache reads). No cache-write counter — leave at 0.
 *
 * @param {string | null | undefined} raw
 * @returns {Promise<ParsedRun>}
 */
export async function parseStream(raw) {
  const run = emptyRun();
  if (!raw) return run;

  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    /** @type {Record<string, any>} */
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError('parse_error', `malformed JSON on line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    if (run.raw_event_count !== undefined) run.raw_event_count++;

    switch (ev.type) {
      case TYPE_THREAD_STARTED: {
        if (typeof ev.thread_id === 'string' && ev.thread_id) run.session_id = ev.thread_id;
        break;
      }
      case TYPE_ITEM_COMPLETED: {
        const item = ev.item || {};
        if (item.type === ITEM_TYPE_AGENT_MESSAGE) {
          if (typeof item.text === 'string') run.text += item.text;
        } else if (item.type === ITEM_TYPE_COMMAND) {
          if (typeof item.command === 'string' && item.command) {
            run.commands_run.push(item.command);
          }
        } else if (item.type === ITEM_TYPE_FILE_CHANGE) {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const c of changes) {
            const p = c && typeof c.path === 'string' ? c.path : null;
            if (p && !run.files_changed.includes(p)) run.files_changed.push(p);
          }
        }
        break;
      }
      case TYPE_TURN_COMPLETED: {
        const u = ev.usage || {};
        if (typeof u.input_tokens === 'number') run.tokens.input = u.input_tokens;
        if (typeof u.output_tokens === 'number') run.tokens.output = u.output_tokens;
        if (typeof u.cached_input_tokens === 'number') run.tokens.cache_read = u.cached_input_tokens;
        if (typeof u.reasoning_output_tokens === 'number') run.tokens.reasoning = u.reasoning_output_tokens;
        // codex has no cache_write equivalent — leave run.tokens.cache_write at 0.
        break;
      }
      case TYPE_TURN_FAILED: {
        const msg = ev.error?.message;
        run.errors.push(makeError('internal', typeof msg === 'string' && msg ? msg : 'agent-reported error'));
        break;
      }
      case TYPE_ERROR: {
        // Mid-stream error preceding turn.failed (observed in error.jsonl).
        // Skipping it would lose detail when the terminal turn.failed message
        // is generic; keeping both is harmless — RunNotifier surfaces them
        // separately.
        const msg = typeof ev.message === 'string' ? ev.message : 'agent-reported error';
        run.errors.push(makeError('internal', msg));
        break;
      }
      default:
        // turn.started / item.started / unknown future event types are
        // counted by raw_event_count above but produce no ParsedRun
        // mutations. Tool starts surface as MCP progress via
        // streamEventLabel — they aren't reflected in the final ParsedRun.
        break;
    }
  }

  return run;
}

/**
 * Per-line stream-event labeling for codex. Mirrors cursor's
 * `streamEventLabel` so runOne can emit MCP progress notifications uniformly
 * across adapters.
 *
 * @param {string} line
 * @returns {{ kind: string, label: string } | null}
 */
export function streamEventLabel(line) {
  if (!line) return null;
  /** @type {Record<string, any>} */
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  switch (ev.type) {
    case TYPE_THREAD_STARTED:
      return { kind: 'session_init', label: 'session started' };
    case TYPE_ITEM_STARTED: {
      const itemType = ev.item?.type;
      if (!itemType || itemType === ITEM_TYPE_AGENT_MESSAGE) return null;
      return { kind: 'tool_start', label: `tool: ${itemType}` };
    }
    case TYPE_ITEM_COMPLETED: {
      const itemType = ev.item?.type;
      if (itemType === ITEM_TYPE_AGENT_MESSAGE) {
        return { kind: 'assistant', label: 'model responded' };
      }
      if (!itemType) return null;
      return { kind: 'tool_done', label: 'tool done' };
    }
    case TYPE_TURN_COMPLETED:
      return { kind: 'result', label: 'completed' };
    case TYPE_TURN_FAILED:
    case TYPE_ERROR:
      return { kind: 'result_error', label: 'agent error' };
    default:
      return null;
  }
}

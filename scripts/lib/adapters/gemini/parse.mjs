import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").ParsedRun} ParsedRun */

// Event type discriminators from .cursed/gemini-discovery.md
// Pins the wire format captured in test/fixtures/streams/gemini/.
const TYPE_SESSION_STARTED = 'init';
const TYPE_MESSAGE = 'message'; // role === 'assistant' for model output
const TYPE_TOOL_USE = 'tool_use'; // tool_name field: run_shell_command, write_file, update_topic, read_file
const TYPE_TOOL_RESULT = 'tool_result';
const TYPE_ERROR = 'error'; // mid-stream severity-annotated error (NOT terminal)
const TYPE_RESULT = 'result'; // terminal event; check ev.status === 'success'

// Tool-kind discriminators (ev.tool_name)
const TOOL_SHELL = 'run_shell_command';
const TOOL_WRITE = 'write_file';

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
 * Parse a `gemini -o stream-json` transcript into a ParsedRun.
 * Non-JSON lines (gemini emits status messages to stdout) are skipped silently.
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
    if (trimmed === '' || !trimmed.startsWith('{')) continue;

    /** @type {Record<string, any>} */
    let _ev;
    try {
      _ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError('parse_error', `malformed JSON on line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    run.raw_event_count++;

    // Event-type branches added in Tasks 8-11.
    switch (_ev.type) {
      case TYPE_SESSION_STARTED: {
        const id = _ev.session_id;
        if (typeof id === 'string' && id) run.session_id = id;
        break;
      }
      case TYPE_MESSAGE: {
        if (_ev.role !== 'assistant') break;
        const text = typeof _ev.content === 'string' ? _ev.content : null;
        if (text) run.text += text;
        break;
      }
      case TYPE_TOOL_USE: {
        const toolName = _ev.tool_name;
        if (toolName === TOOL_SHELL) {
          const cmd = _ev.parameters?.command;
          if (typeof cmd === 'string' && cmd) run.commands_run.push(cmd);
        } else if (toolName === TOOL_WRITE) {
          const filePath = _ev.parameters?.file_path;
          if (typeof filePath === 'string' && filePath && !run.files_changed.includes(filePath)) {
            run.files_changed.push(filePath);
          }
        }
        // update_topic and read_file are gemini-internal tools — skip silently
        break;
      }
      case TYPE_RESULT: {
        // Single terminal event for both success and failure.
        // Token fields live under ev.stats (NOT ev.usage — gemini naming differs).
        const s = _ev.stats ?? {};
        const inputN = s.input_tokens;
        const outputN = s.output_tokens;
        const cacheReadN = s.cached; // gemini calls it 'cached', not 'cached_input_tokens'
        if (typeof inputN === 'number') run.tokens.input = inputN;
        if (typeof outputN === 'number') run.tokens.output = outputN;
        if (typeof cacheReadN === 'number') run.tokens.cache_read = cacheReadN;
        // cache_write not reported by gemini; stays at 0

        if (_ev.status !== 'success') {
          const msg = _ev.error?.message ?? _ev.message ?? 'agent-reported error';
          run.errors.push(makeError('internal', typeof msg === 'string' && msg ? msg : 'agent-reported error'));
        }
        break;
      }
      case TYPE_ERROR: {
        // Mid-stream advisory error (has severity field, distinct from terminal result)
        const msg = _ev.message ?? 'agent-reported error';
        run.errors.push(makeError('internal', typeof msg === 'string' && msg ? msg : 'agent-reported error'));
        break;
      }
      default:
        void TYPE_TOOL_RESULT;
    }
  }

  return run;
}

/**
 * Per-line stream-event labeling. Mirrors cursor's and codex's labelers so
 * runOne emits MCP progress notifications uniformly across adapters.
 * Returns null for non-JSON lines, unknown events, and user-role messages.
 *
 * @param {string} line
 * @returns {{ kind: string, label: string } | null}
 */
export function streamEventLabel(line) {
  if (!line?.trim()) return null;
  /** @type {Record<string, any>} */
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  switch (ev.type) {
    case TYPE_SESSION_STARTED:
      return { kind: 'session_init', label: 'session started' };
    case TYPE_MESSAGE:
      if (ev.role !== 'assistant') return null;
      return { kind: 'assistant', label: 'model responded' };
    case TYPE_TOOL_USE:
      return { kind: 'tool_start', label: `tool: ${ev.tool_name ?? 'tool'}` };
    case TYPE_TOOL_RESULT:
      return { kind: 'tool_done', label: 'tool done' };
    case TYPE_RESULT:
      return ev.status === 'success'
        ? { kind: 'result', label: 'completed' }
        : { kind: 'result_error', label: 'agent error' };
    case TYPE_ERROR:
      return { kind: 'result_error', label: 'agent error' };
    default:
      return null;
  }
}

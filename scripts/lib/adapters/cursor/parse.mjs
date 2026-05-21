import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").ParsedRun} ParsedRun */
/** @typedef {import("../../types.d.ts").TokenCounts} TokenCounts */

// Event type discriminators (type, subtype) — observed in cursor-agent
// stream-json output as of cursor-agent 2026.04.17. See docs/discovery-notes.md.
/** @type {readonly [string, string | null]} */
const TYPE_SYSTEM_INIT = ['system', 'init']; // session start
/** @type {readonly [string, string | null]} */
const TYPE_ASSISTANT = ['assistant', null]; // final assistant msg
/** @type {readonly [string, string | null]} */
const TYPE_TOOL_CALL_STARTED = ['tool_call', 'started'];
/** @type {readonly [string, string | null]} */
const TYPE_TOOL_CALL_DONE = ['tool_call', 'completed'];
/** @type {readonly [string, string | null]} */
const TYPE_RESULT_SUCCESS = ['result', 'success']; // session end (ok)
/** @type {readonly [string, string | null]} */
const TYPE_RESULT_ERROR = ['result', 'error']; // session end (err) — presumed; not observed

// Tool wrapper keys inside `tool_call.<wrapperKey>`.
// Add new tool names here as they are encountered in fixtures.
/** @type {Set<string>} */
const FILE_WRITE_TOOLS = new Set(['editToolCall', 'writeToolCall', 'createToolCall']);
/** @type {Set<string>} */
const SHELL_TOOLS = new Set(['shellToolCall']);

/**
 * @param {Record<string, any>} ev
 * @param {readonly [string, string | null]} match
 * @returns {boolean}
 */
function matchEvent(ev, [wantType, wantSub]) {
  if (ev.type !== wantType) return false;
  if (wantSub === null) return true;
  return ev.subtype === wantSub;
}

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
 * Extract concatenated text from an Anthropic-style content-block array.
 *
 * @param {unknown} content
 * @returns {string}
 */
function textFromContentBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Parse a cursor-agent stream-json transcript into a ParsedRun.
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

    if (matchEvent(ev, TYPE_SYSTEM_INIT)) {
      if (ev.session_id) run.session_id = ev.session_id;
      continue;
    }

    if (matchEvent(ev, TYPE_ASSISTANT)) {
      // Final message — single event, content-block array under ev.message.content.
      run.text = textFromContentBlocks(ev.message?.content);
      if (ev.session_id && !run.session_id) run.session_id = ev.session_id;
      continue;
    }

    if (matchEvent(ev, TYPE_TOOL_CALL_DONE)) {
      // Tool results are inlined here. Pick whichever wrapper key is present.
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
      // duration_ms is intentionally NOT read from the stream. runOne tracks
      // wall-clock from spawn to terminal watchdog and writes the
      // RunRecord's duration_ms itself. Codex's turn.completed has no
      // duration field; centralizing in runOne keeps adapters symmetric.
      if (ev.usage) {
        if (typeof ev.usage.inputTokens === 'number') run.tokens.input = ev.usage.inputTokens;
        if (typeof ev.usage.outputTokens === 'number') run.tokens.output = ev.usage.outputTokens;
        if (typeof ev.usage.cacheReadTokens === 'number') run.tokens.cache_read = ev.usage.cacheReadTokens;
        if (typeof ev.usage.cacheWriteTokens === 'number') run.tokens.cache_write = ev.usage.cacheWriteTokens;
      }
      if (ev.session_id && !run.session_id) run.session_id = ev.session_id;
      if (ev.subtype === 'error' || ev.is_error) {
        const msg = typeof ev.result === 'string' ? ev.result : 'agent-reported error';
        run.errors.push(makeError('internal', msg));
      }
      continue;
    }

    // Other event types (user echo, thinking/delta, thinking/completed,
    // tool_call/started) are counted but produce no ParsedRun mutations.
    void TYPE_TOOL_CALL_STARTED;
  }

  return run;
}

/**
 * Per-line stream-event labeling. Maps one NDJSON line emitted by
 * cursor-agent to a short `{kind, label}` if it's worth surfacing as a
 * progress event, or `null` if it should be ignored.
 *
 * Used by `runOne` to emit MCP progress notifications as the run unfolds.
 * Tolerant of malformed lines and unknown event types — non-recognized
 * lines simply return null.
 *
 * @param {string} line - one trimmed line of NDJSON
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

  if (matchEvent(ev, TYPE_SYSTEM_INIT)) {
    return { kind: 'session_init', label: 'session started' };
  }
  if (matchEvent(ev, TYPE_TOOL_CALL_STARTED)) {
    const wrapper = ev.tool_call || {};
    const wrapperKey = Object.keys(wrapper)[0] ?? 'tool';
    return { kind: 'tool_start', label: `tool: ${wrapperKey}` };
  }
  if (matchEvent(ev, TYPE_TOOL_CALL_DONE)) {
    return { kind: 'tool_done', label: 'tool done' };
  }
  if (matchEvent(ev, TYPE_ASSISTANT)) {
    return { kind: 'assistant', label: 'model responded' };
  }
  if (matchEvent(ev, TYPE_RESULT_SUCCESS)) {
    return { kind: 'result', label: 'completed' };
  }
  if (matchEvent(ev, TYPE_RESULT_ERROR)) {
    return { kind: 'result_error', label: 'agent error' };
  }
  return null;
}

import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeError } from '../../errors.mjs';

/** @typedef {import("../../types.d.ts").ParsedRun} ParsedRun */

// Transcript event discriminators — see .cursed/antigravity-discovery.md.
// Confirmed against the captured fixtures in Task 1.
const TYPE_PLANNER_RESPONSE = 'PLANNER_RESPONSE'; // carries model `content` (+ optional tool_calls)
const TYPE_ERROR_MESSAGE = 'ERROR_MESSAGE'; // a failed step; `content` holds the error text
const TOOL_RUN_COMMAND = 'run_command'; // shell tool; arg `CommandLine`
const ARG_COMMAND_LINE = 'CommandLine';
const TOOL_WRITE_FILE = 'write_to_file'; // file-write tool; path arg `TargetFile`
const ARG_FILE_PATH = 'TargetFile';

/**
 * Strip one layer of surrounding double quotes. `agy` records tool-call arg
 * values double-JSON-quoted (`"\"ls -la\""` -> JS string `"ls -la"`).
 *
 * @param {unknown} value
 * @returns {string}
 */
function unquote(value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
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
 * Parse an `agy` `transcript.jsonl` (line-delimited JSON) into a ParsedRun.
 * Pure — no I/O. `sessionId` is supplied by the caller because the id is the
 * conversation directory name, not a field inside the transcript.
 *
 * @param {string | null | undefined} text
 * @param {string | null} sessionId
 * @returns {Required<ParsedRun>}
 */
export function parseTranscript(text, sessionId) {
  const run = emptyRun();
  run.session_id = sessionId ?? null;
  if (!text) return run;

  /** @type {string[]} */
  const textParts = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Skips blank lines, the fixture `// ...` provenance header, and any other
    // non-object line — all of which fail the `startsWith('{')` test.
    if (trimmed === '' || !trimmed.startsWith('{')) continue;

    /** @type {Record<string, any>} */
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      run.errors.push(makeError('parse_error', `malformed transcript line: ${trimmed.slice(0, 120)}`));
      continue;
    }
    run.raw_event_count++;

    for (const tc of Array.isArray(ev.tool_calls) ? ev.tool_calls : []) {
      if (tc?.name === TOOL_RUN_COMMAND) {
        const cmd = unquote(tc.args?.[ARG_COMMAND_LINE]);
        if (cmd) run.commands_run.push(cmd);
      } else if (tc?.name === TOOL_WRITE_FILE) {
        const filePath = unquote(tc.args?.[ARG_FILE_PATH]);
        if (filePath && !run.files_changed.includes(filePath)) run.files_changed.push(filePath);
      }
    }

    if (ev.type === TYPE_PLANNER_RESPONSE && typeof ev.content === 'string' && ev.content) {
      textParts.push(ev.content);
    }

    if (ev.type === TYPE_ERROR_MESSAGE) {
      const msg = typeof ev.content === 'string' && ev.content ? ev.content : 'agy step failed';
      run.errors.push(makeError('internal', msg));
    }
  }

  run.text = textParts.join('\n');
  return run;
}

/**
 * Parse one `agy --print` run into a ParsedRun.
 *
 * `agy` emits no structured stdout — the structured record is a sidecar file.
 * Given the run's `cwd`, this resolves the conversation id from
 * `~/.gemini/antigravity-cli/cache/last_conversations.json` and parses
 * `~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl`.
 * If the cwd is absent or any of those files cannot be read, it falls back to
 * treating the raw stdout as the run text. Never throws.
 *
 * `_readFile` / `_homedir` are test seams (mirrors `adapterForModel`'s `_readFile`).
 *
 * @param {string | null | undefined} raw - child stdout
 * @param {{ cwd?: string,
 *           _readFile?: (path: string, encoding: string) => Promise<string>,
 *           _homedir?: () => string }} [context]
 * @returns {Promise<ParsedRun>}
 */
export async function parseStream(raw, context = {}) {
  const { cwd, _readFile = fsReadFile, _homedir = homedir } = context;

  if (cwd) {
    try {
      const home = _homedir();
      const mapPath = join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
      const map = JSON.parse(await _readFile(mapPath, 'utf8'));
      const convId = map[cwd];
      if (typeof convId === 'string' && convId) {
        const transcriptPath = join(
          home,
          '.gemini',
          'antigravity-cli',
          'brain',
          convId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        const transcriptText = await _readFile(transcriptPath, 'utf8');
        return parseTranscript(transcriptText, convId);
      }
    } catch {
      // Mapping/transcript missing or malformed — fall through to stdout fallback.
    }
  }

  const run = emptyRun();
  run.text = typeof raw === 'string' ? raw.trim() : '';
  return run;
}

/**
 * Per-line stream-event labeling. `agy`'s stdout is plain-text narration — one
 * sentence per agent step — so every non-empty line is a meaningful progress
 * tick. Returns null for empty lines.
 *
 * @param {string} line
 * @returns {{ kind: string, label: string } | null}
 */
export function streamEventLabel(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) return null;
  const label = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return { kind: 'narration', label };
}

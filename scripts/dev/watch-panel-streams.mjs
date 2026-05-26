#!/usr/bin/env node
// watch-panel-streams.mjs — render real-time per-model status for a running
// /cursed:review panel by tailing the per-model transcript jsonl files in
// `<workspaceDir>/runs/<date>/`.
//
// Used by scripts/dev/record-demo-side-by-side.sh as the right-hand pane of
// the side-by-side demo recording. Operates in two modes:
//
//   1. watch  — tail real transcripts as they grow during a live panel run
//   2. replay — read a captured panel-result.json and synthesize the same
//               visual flow for dry-run iteration (no model calls)
//
// Usage:
//   watch-panel-streams.mjs watch  <runs-dir> <model1>[,<model2>,...]
//   watch-panel-streams.mjs replay <panel-result.json>
//
// The replay path simulates real timing: each model "thinks" for a wait
// interval that matches its real wall time, then its response text streams
// into the pane at ~80 cps. Good enough for visual iteration without
// burning a real panel run.

import { readFile, readdir, stat } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import { join } from 'node:path';

// ── Terminal dims ──────────────────────────────────────────────────────────
const COLS = Number(process.env.COLUMNS) || process.stdout.columns || 90;
const ROWS = Number(process.env.LINES) || process.stdout.rows || 30;

// ── ANSI helpers ───────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
// ANSI SGR / cursor escape sequences. Built from CSI rather than a regex
// literal so the control character lives in a string (which biome accepts)
// instead of a regex literal (which it flags as suspicious).
const ANSI_SGR_GLOBAL = new RegExp(`${CSI}[0-9;?]*[a-zA-Z]`, 'g');
const ANSI_SGR_PREFIX = new RegExp(`^${CSI}[0-9;?]*[a-zA-Z]`);
const ansi = {
  clearScreen: () => `${CSI}2J${CSI}H`,
  /** @param {number} row @param {number} col */
  moveTo: (row, col) => `${CSI}${row};${col}H`,
  clearLine: () => `${CSI}2K`,
  hideCursor: () => `${CSI}?25l`,
  showCursor: () => `${CSI}?25h`,
  reset: () => `${CSI}0m`,
  /** @param {string} s */ bold: (s) => `${CSI}1m${s}${CSI}22m`,
  /** @param {string} s */ dim: (s) => `${CSI}2m${s}${CSI}22m`,
  /** @param {string} s */ cyan: (s) => `${CSI}36m${s}${CSI}39m`,
  /** @param {string} s */ green: (s) => `${CSI}32m${s}${CSI}39m`,
  /** @param {string} s */ yellow: (s) => `${CSI}33m${s}${CSI}39m`,
  /** @param {string} s */ red: (s) => `${CSI}31m${s}${CSI}39m`,
  /** @param {string} s */ magenta: (s) => `${CSI}35m${s}${CSI}39m`,
};

// ── Stream event extraction (adapter-agnostic) ─────────────────────────────
/**
 * Returns one of: { kind: 'start' | 'tool' | 'tool_done' | 'thinking' | 'response' | 'done' | 'error', ... }
 * or null if the line is unrecognized. Handles cursor, codex, gemini, antigravity formats.
 *
 * @param {string} line
 * @returns {Record<string, any> | null}
 */
export function extractEvent(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let ev;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  // cursor-agent shape: {type, subtype, ...}
  // cursor emits one `assistant` event at the end with the full text — replace.
  if (ev.type === 'system' && ev.subtype === 'init') return { kind: 'start' };
  if (ev.type === 'thinking') return { kind: 'thinking' };
  if (ev.type === 'tool_call' && ev.subtype === 'started') {
    const key = Object.keys(ev.tool_call ?? {})[0] ?? 'tool';
    return { kind: 'tool', label: key.replace(/ToolCall$/, '') };
  }
  if (ev.type === 'tool_call' && ev.subtype === 'completed') return { kind: 'tool_done' };
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    const text = Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('')
      : '';
    return { kind: 'response', text, append: false };
  }
  // cursor's `result` always carries a `subtype`. Gemini's `result` carries
  // a `status` field instead — handle that further down so this branch
  // doesn't misclassify gemini's status=success as ok=false.
  if (ev.type === 'result' && ev.subtype !== undefined) {
    return {
      kind: 'done',
      ok: ev.subtype === 'success',
      tokens: ev.usage ? { input: ev.usage.inputTokens, output: ev.usage.outputTokens } : null,
    };
  }

  // codex shape: {type: 'thread.started' | 'turn.*' | 'item.*', ...}
  if (ev.type === 'thread.started') return { kind: 'start' };
  if (ev.type === 'item.started') {
    const itemType = ev.item?.type;
    if (itemType === 'command_execution') return { kind: 'tool', label: 'exec' };
    if (itemType === 'file_change') return { kind: 'tool', label: 'edit' };
    return null;
  }
  if (ev.type === 'item.completed') {
    const itemType = ev.item?.type;
    if (itemType === 'agent_message') {
      // codex can emit multiple agent_message items per turn — accumulate
      // them in stream order to match the parser at scripts/lib/adapters/codex/parse.mjs.
      return { kind: 'response', text: ev.item.text ?? '', append: true };
    }
    if (itemType === 'command_execution' || itemType === 'file_change') {
      return { kind: 'tool_done' };
    }
    return null;
  }
  if (ev.type === 'turn.completed') {
    const u = ev.usage ?? {};
    return {
      kind: 'done',
      ok: true,
      tokens: { input: u.input_tokens, output: u.output_tokens },
    };
  }
  if (ev.type === 'turn.failed' || ev.type === 'error') {
    return { kind: 'error', message: ev.error?.message ?? ev.message ?? 'agent error' };
  }

  // gemini shape: {type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error'}
  if (ev.type === 'init') return { kind: 'start' };
  if (ev.type === 'tool_use') {
    return { kind: 'tool', label: ev.tool_name ?? 'tool' };
  }
  if (ev.type === 'tool_result') return { kind: 'tool_done' };
  if (ev.type === 'message' && ev.role === 'assistant') {
    const content = ev.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
    }
    // gemini emits incremental `delta: true` messages — append each chunk.
    // Non-delta messages (if any) are treated as complete and also appended;
    // a final whole-message would harmlessly duplicate, but in practice
    // gemini only sends deltas for streaming output.
    return { kind: 'response', text, append: ev.delta === true };
  }
  // gemini result event uses 'status' instead of 'subtype'
  if (ev.type === 'result' && ev.status !== undefined) {
    return { kind: 'done', ok: ev.status === 'success', tokens: null };
  }

  return null;
}

// ── Per-model state ────────────────────────────────────────────────────────
/**
 * @typedef {object} ModelState
 * @property {string} model
 * @property {number} startMs
 * @property {'waiting'|'running'|'done'|'failed'} status
 * @property {number} events
 * @property {number} tools
 * @property {string} lastLabel
 * @property {string} text                         - Final assistant text (once 'done')
 * @property {number} textPrintedChars             - For paced streaming on completion
 * @property {{input?:number, output?:number}|null} tokens
 * @property {number|null} doneAt
 */

/**
 * @param {string} model
 * @returns {ModelState}
 */
function newState(model) {
  return {
    model,
    startMs: 0,
    status: /** @type {'waiting'} */ ('waiting'),
    events: 0,
    tools: 0,
    lastLabel: '—',
    text: '',
    textPrintedChars: 0,
    tokens: null,
    doneAt: null,
  };
}

/**
 * Apply one extracted event into the model's state.
 *
 * @param {ModelState} state
 * @param {Record<string, any> | null} evt
 * @param {number} nowMs
 */
function applyEvent(state, evt, nowMs) {
  if (!evt) return;
  state.events++;
  switch (evt.kind) {
    case 'start':
      if (state.status === 'waiting') {
        state.status = 'running';
        state.startMs = nowMs;
      }
      state.lastLabel = 'session started';
      break;
    case 'thinking':
      state.lastLabel = 'thinking';
      break;
    case 'tool':
      state.tools++;
      state.lastLabel = `tool: ${evt.label}`;
      break;
    case 'tool_done':
      state.lastLabel = 'tool done';
      break;
    case 'response':
      // append: true when the adapter streams text in chunks (gemini deltas,
      // codex multi-message). false when the adapter emits one complete
      // message at the end (cursor).
      if (evt.append) state.text += evt.text || '';
      else state.text = evt.text || '';
      state.lastLabel = 'model responded';
      break;
    case 'done':
      state.status = evt.ok === false ? 'failed' : 'done';
      state.doneAt = nowMs;
      if (evt.tokens) state.tokens = evt.tokens;
      state.lastLabel = state.status === 'failed' ? 'failed' : 'completed';
      break;
    case 'error':
      state.status = 'failed';
      state.lastLabel = 'error';
      state.text = String(evt.message ?? '');
      state.doneAt = nowMs;
      break;
  }
}

// ── Renderer ───────────────────────────────────────────────────────────────
// Pane budget: total ROWS, divided into 3 model panes + 2 dividers + 1 header.
// Each pane gets: header row + status row + (N-3) text rows + footer row.

function paneHeight() {
  // header(1) + 3 dividers(3) = 4; rest split across 3 panes.
  const budget = Math.max(12, ROWS - 1);
  return Math.floor((budget - 3) / 3);
}

/** @param {number} ms @returns {string} */
function fmtElapsed(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

/** @param {ModelState} state @param {number} nowMs @returns {string} */
function statusBadge(state, nowMs) {
  if (state.status === 'waiting') return ansi.dim('◯ waiting');
  if (state.status === 'running') {
    const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(nowMs / 100) % 10];
    return ansi.yellow(`${spin} running`);
  }
  if (state.status === 'done') return ansi.green('✓ done');
  return ansi.red('✗ failed');
}

/** @param {string} s @param {number} width @returns {string} */
function truncate(s, width) {
  // Strip ANSI for width measurement; if it already fits, return unchanged
  // so colour codes are preserved.
  const visible = s.replace(ANSI_SGR_GLOBAL, '');
  if (visible.length <= width) return s;
  // Naive: walk visible characters and emit until budget exhausted. Drops
  // any ANSI that survives the cut — acceptable for our row content.
  let out = '';
  let used = 0;
  let i = 0;
  while (i < s.length && used < width - 1) {
    if (s[i] === ESC && s[i + 1] === '[') {
      const m = ANSI_SGR_PREFIX.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    used++;
    i++;
  }
  return `${out}…`;
}

/** @param {string} s @returns {number} */
function visibleLen(s) {
  // Count printable width, stripping ANSI SGR. Treats most chars as width 1;
  // good enough for our renderer (no CJK/emoji wide chars in our content).
  return s.replace(ANSI_SGR_GLOBAL, '').length;
}

/**
 * @param {ModelState} state
 * @param {number} paneW
 * @param {number} paneH
 * @param {number} nowMs
 * @param {boolean} paceText
 * @returns {string[]}
 */
function renderPane(state, paneW, paneH, nowMs, paceText) {
  /** @type {string[]} */
  const lines = [];
  const elapsed = state.startMs ? nowMs - state.startMs : 0;
  const badge = statusBadge(state, nowMs);
  const dimD = ansi.dim;

  // ── header: ┌─ <title> ───────┐ ────────────────────────────────────────
  // Title segment includes leading/trailing dashes so the corners always sit
  // flush at columns 1 and paneW.
  const titleInner = ` ${ansi.bold(ansi.cyan(state.model))} ${dimD('·')} ${badge} ${dimD('·')} ${fmtElapsed(elapsed)} `;
  const titleVisW = visibleLen(titleInner);
  const dashes = Math.max(0, paneW - 2 - titleVisW - 1); // -1 for the leading dash before title
  lines.push(dimD('┌─') + titleInner + dimD('─'.repeat(dashes)) + dimD('┐'));

  // ── status row ─────────────────────────────────────────────────────────
  const tokParts = [];
  if (state.tokens) {
    if (state.tokens.input) tokParts.push(`${state.tokens.input.toLocaleString()} in`);
    if (state.tokens.output) tokParts.push(`${state.tokens.output.toLocaleString()} out`);
  }
  const statusInner =
    `${dimD('events')} ${state.events}` +
    `  ${dimD('tools')} ${state.tools}` +
    (tokParts.length ? `  ${dimD('tokens')} ${tokParts.join(' / ')}` : '') +
    `  ${dimD('last:')} ${state.lastLabel}`;
  lines.push(boxedRow(statusInner, paneW));

  // ── text body (paneH - 3 rows) ─────────────────────────────────────────
  const bodyRows = paneH - 3;
  let bodyText = '';
  if (state.status === 'done' || state.status === 'failed') {
    const visibleChars = paceText ? Math.min(state.text.length, state.textPrintedChars) : state.text.length;
    bodyText = state.text.slice(0, visibleChars);
  }
  const bodyLines = wrapLines(bodyText, paneW - 4);
  for (let i = 0; i < bodyRows; i++) {
    lines.push(boxedRow(bodyLines[i] ?? '', paneW));
  }

  // ── footer ─────────────────────────────────────────────────────────────
  lines.push(dimD('└') + dimD('─'.repeat(paneW - 2)) + dimD('┘'));

  return lines;
}

// Wrap a row in │ … │ borders, padding the inner content to (paneW-4).
// Handles ANSI codes correctly via visibleLen.
/** @param {string} inner @param {number} paneW @returns {string} */
function boxedRow(inner, paneW) {
  const innerW = paneW - 4;
  const truncated = truncate(inner, innerW);
  const pad = Math.max(0, innerW - visibleLen(truncated));
  return ansi.dim('│') + ' ' + truncated + ' '.repeat(pad) + ' ' + ansi.dim('│');
}

/** @param {string} text @param {number} width @returns {string[]} */
function wrapLines(text, width) {
  if (!text) return [];
  /** @type {string[]} */
  const out = [];
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > width) {
      // Try to break at the last space within `width`.
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= width / 2) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * @param {ModelState[]} states
 * @param {number} nowMs
 * @param {boolean} paceText
 * @returns {string}
 */
function renderAll(states, nowMs, paceText) {
  const out = [ansi.clearScreen(), ansi.hideCursor()];
  // Header line.
  out.push(ansi.moveTo(1, 1));
  out.push(
    ansi.bold(ansi.magenta('  BEHIND THE SCENES')) +
      ansi.dim(`  ·  ${states.length} models  ·  ${(nowMs / 1000).toFixed(1)}s`),
  );

  const paneH = paneHeight();
  let row = 3;
  for (const state of states) {
    const lines = renderPane(state, COLS - 2, paneH, nowMs, paceText);
    for (const ln of lines) {
      out.push(ansi.moveTo(row, 2));
      out.push(ln);
      row++;
    }
    row++; // spacer
  }
  out.push(ansi.reset());
  return out.join('');
}

// ── Watch mode: tail real transcript files ─────────────────────────────────
/** @param {string} runsDir @param {string} model @returns {Promise<string | null>} */
async function findTranscriptForModel(runsDir, model) {
  const safeModel = String(model).replace(/[^a-zA-Z0-9._-]/g, '_');
  // Walk runs/<date>/ subdirs, find newest *-review-<safeModel>.jsonl.
  let dates;
  try {
    dates = (await readdir(runsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const date of dates) {
    const sub = join(runsDir, date);
    let entries;
    try {
      entries = await readdir(sub);
    } catch {
      continue;
    }
    const matches = entries
      .filter((f) => f.endsWith(`-review-${safeModel}.jsonl`))
      .sort()
      .reverse();
    if (matches.length) return join(sub, matches[0]);
  }
  return null;
}

/**
 * @param {string} path
 * @param {(line: string) => void} onLine
 * @returns {Promise<() => void>}
 */
async function tailFile(path, onLine) {
  let offset = 0;
  let buffer = '';
  const readMore = async () => {
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.size <= offset) return;
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'r');
    try {
      const bytes = info.size - offset;
      const buf = Buffer.alloc(bytes);
      await fh.read(buf, 0, bytes, offset);
      offset = info.size;
      buffer += buf.toString('utf8');
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    } finally {
      await fh.close();
    }
  };
  await readMore();
  const w = fsWatch(path, { persistent: false }, () => {
    readMore().catch(() => {});
  });
  return () => w.close();
}

/** @param {string} runsDir @param {string} modelsArg @returns {Promise<void>} */
async function watchMode(runsDir, modelsArg) {
  /** @type {string[]} */
  const models = modelsArg
    .split(',')
    .map((/** @type {string} */ s) => s.trim())
    .filter(Boolean);
  if (!models.length) {
    process.stderr.write('error: no models specified\n');
    process.exit(2);
  }
  const states = models.map((/** @type {string} */ m) => newState(m));
  /** @type {(null | (() => void))[]} */
  const tailers = new Array(models.length).fill(null);
  const renderStart = Date.now();
  // Hard safety timeout. If something goes wrong upstream (panel never
  // produces transcripts, model adapter hangs), bail out so we don't keep
  // the asciinema recording open forever.
  const MAX_WAIT_MS = Number(process.env.WATCH_MAX_WAIT_MS || 600_000); // 10 min

  const tick = () => {
    const now = Date.now() - renderStart;
    process.stdout.write(renderAll(states, now, false));
  };

  // Poll for transcript files until they appear, then attach tailers.
  const findInterval = setInterval(async () => {
    for (let i = 0; i < models.length; i++) {
      if (tailers[i]) continue;
      const path = await findTranscriptForModel(runsDir, models[i]);
      if (!path) continue;
      tailers[i] = await tailFile(path, (line) => {
        const evt = extractEvent(line);
        applyEvent(states[i], evt, Date.now() - renderStart);
      });
    }
  }, 250);

  const renderInterval = setInterval(tick, 100);

  // Exit when all models reached terminal status, OR when MAX_WAIT_MS
  // elapses (safety so the recording never hangs forever).
  const exitInterval = setInterval(() => {
    const allDone = states.every((s) => s.status === 'done' || s.status === 'failed');
    const timedOut = Date.now() - renderStart > MAX_WAIT_MS;
    if (allDone || timedOut) {
      clearInterval(findInterval);
      clearInterval(renderInterval);
      clearInterval(exitInterval);
      // One last full render + linger so the human/screen-recorder sees it.
      tick();
      setTimeout(() => {
        process.stdout.write(ansi.showCursor());
        process.stdout.write(ansi.moveTo(ROWS, 1) + '\n');
        process.exit(timedOut && !allDone ? 1 : 0);
      }, 1500);
    }
  }, 200);

  process.on('SIGINT', () => {
    for (const close of tailers) if (close) close();
    process.stdout.write(ansi.showCursor());
    process.exit(130);
  });
}

// ── Replay mode: synthesize the flow from a panel-result.json ──────────────
/**
 * @typedef {object} ReplayRun
 * @property {string} model
 * @property {string} [status]
 * @property {string} [text]
 * @property {number} [duration_ms]
 * @property {{ input?: number, output?: number } | null} [tokens]
 */

/** @param {string} resultPath @returns {Promise<void>} */
async function replayMode(resultPath) {
  const raw = await readFile(resultPath, 'utf8');
  const result = JSON.parse(raw);
  /** @type {ReplayRun[]} */
  const runs = result.runs ?? [];
  if (!runs.length) {
    process.stderr.write('error: panel-result.json has no runs\n');
    process.exit(2);
  }

  const states = runs.map((/** @type {ReplayRun} */ r) => newState(r.model));
  const renderStart = Date.now();

  // Schedule per-model lifecycle. To keep the demo short, condense real
  // durations into a ~15s window; stagger completion times to add visual
  // interest. After a model completes, its (truncated) text streams into the
  // pane at STREAM_CPS — viewer-readable, finishes within a few seconds.
  const TOTAL_MS = 15_000;
  const STREAM_CPS = 220;
  // Visible body capacity per pane (rows × cols). We trim the text to roughly
  // this many chars so the post-completion streaming doesn't run long after
  // the visible area is full.
  const VISIBLE_CHARS = Math.max(120, (paneHeight() - 3) * (COLS - 6));

  const realDurations = runs.map((/** @type {ReplayRun} */ r) => r.duration_ms ?? 60_000);
  const maxReal = Math.max(...realDurations);
  const scale = TOTAL_MS / maxReal;

  // Each run: emit a start event at t=0, fake "thinking" ticks during the
  // wait, then a response event at t=scaledDuration. After that, we pace
  // the text into the pane character-by-character at STREAM_CPS so the
  // viewer sees the response materialize.
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const stop = Math.round(realDurations[i] * scale);

    setTimeout(() => applyEvent(states[i], { kind: 'start' }, Date.now() - renderStart), 50);
    // Thinking ticks every ~600ms during the wait.
    const tickEvery = 600;
    for (let t = tickEvery; t < stop; t += tickEvery) {
      setTimeout(() => applyEvent(states[i], { kind: 'thinking' }, Date.now() - renderStart), t);
    }
    setTimeout(() => {
      // Trim text to what the pane can show; the trailing "…" hints there's
      // more in the real result JSON.
      let text = run.text ?? '';
      if (text.length > VISIBLE_CHARS) {
        const cut = text.lastIndexOf(' ', VISIBLE_CHARS);
        text = text.slice(0, cut > VISIBLE_CHARS / 2 ? cut : VISIBLE_CHARS).trimEnd() + ' …';
      }
      applyEvent(states[i], { kind: 'response', text }, Date.now() - renderStart);
    }, stop);
    setTimeout(() => {
      applyEvent(
        states[i],
        {
          kind: 'done',
          ok: run.status === 'completed',
          tokens: { input: run.tokens?.input ?? 0, output: run.tokens?.output ?? 0 },
        },
        Date.now() - renderStart,
      );
    }, stop + 50);
  }

  const renderInterval = setInterval(() => {
    const now = Date.now() - renderStart;
    // Advance paced-text printer for completed models.
    for (const s of states) {
      if ((s.status === 'done' || s.status === 'failed') && s.doneAt !== null) {
        const sinceDone = now - s.doneAt;
        s.textPrintedChars = Math.min(s.text.length, Math.floor((sinceDone / 1000) * STREAM_CPS));
      }
    }
    process.stdout.write(renderAll(states, now, true));

    if (states.every((s) => (s.status === 'done' || s.status === 'failed') && s.textPrintedChars >= s.text.length)) {
      clearInterval(renderInterval);
      setTimeout(() => {
        process.stdout.write(ansi.showCursor());
        process.stdout.write(ansi.moveTo(ROWS, 1) + '\n');
        process.exit(0);
      }, 1500);
    }
  }, 100);

  process.on('SIGINT', () => {
    process.stdout.write(ansi.showCursor());
    process.exit(130);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────────
function usage() {
  process.stderr.write(
    'usage:\n' +
      '  watch-panel-streams.mjs watch  <runs-dir>          <model1>[,<model2>,...]\n' +
      '  watch-panel-streams.mjs replay <panel-result.json>\n',
  );
}

// Only run the CLI dispatcher when invoked directly (not on import — tests
// import this module to exercise extractEvent).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(`/${process.argv[1]?.split('/').pop() ?? ''}`);

if (isMain) {
  const [, , mode, arg1, arg2] = process.argv;
  if (mode === 'watch') {
    if (!arg1 || !arg2) {
      usage();
      process.exit(2);
    }
    watchMode(arg1, arg2);
  } else if (mode === 'replay') {
    if (!arg1) {
      usage();
      process.exit(2);
    }
    replayMode(arg1);
  } else {
    usage();
    process.exit(2);
  }
}

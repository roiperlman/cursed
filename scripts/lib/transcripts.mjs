import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {import("./types.d.ts").CommandName} CommandName */
/** @typedef {import("./types.d.ts").PanelResult} PanelResult */

/**
 * @param {number} n
 * @param {number} [w]
 * @returns {string}
 */
function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * @param {Date} d
 * @returns {{ date: string; time: string }}
 */
function dateParts(d) {
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
  };
}

/**
 * @typedef {object} OpenTranscriptOptions
 * @property {CommandName} command
 * @property {string} model
 * @property {Date} [now]
 */

/**
 * @typedef {object} TranscriptHandle
 * @property {string} path
 * @property {(line: string) => Promise<void>} writeLine
 * @property {() => Promise<void>} close
 */

/**
 * Opens a per-run transcript file under
 * `<workspaceDir>/runs/<YYYY-MM-DD>/<HHMMSS>-<command>-<model>.jsonl`.
 *
 * @param {string} workspaceDir
 * @param {OpenTranscriptOptions} options
 * @returns {Promise<TranscriptHandle>}
 */
export async function openTranscript(workspaceDir, { command, model, now = new Date() }) {
  const { date, time } = dateParts(now);
  const dir = join(workspaceDir, 'runs', date);
  await mkdir(dir, { recursive: true });
  const safeModel = String(model).replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = join(dir, `${time}-${command}-${safeModel}.jsonl`);

  return {
    path,
    async writeLine(line) {
      await appendFile(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    },
    async close() {
      /* append mode; nothing to flush */
    },
  };
}

/**
 * @typedef {object} WritePanelAggregateOptions
 * @property {string} command - Used in the on-disk filename; accepts any command alias.
 * @property {PanelResult} panelResult
 * @property {Date} [now]
 */

/**
 * Persists a PanelResult JSON aggregate alongside its per-run jsonls.
 *
 * Layout (spec §5.3):
 *   `<workspaceDir>/runs/<YYYY-MM-DD>/<HHMMSS>-<command>.panel.json`
 *
 * @param {string} workspaceDir
 * @param {WritePanelAggregateOptions} options
 * @returns {Promise<string>} Absolute path of the written file.
 */
export async function writePanelAggregate(workspaceDir, { command, panelResult, now = new Date() }) {
  const { date, time } = dateParts(now);
  const dir = join(workspaceDir, 'runs', date);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${time}-${command}.panel.json`);
  await writeFile(path, `${JSON.stringify(panelResult, null, 2)}\n`, 'utf8');
  return path;
}

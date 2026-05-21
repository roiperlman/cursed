/** @type {"--resume"} */
export const RESUME_FLAG = '--resume';
/** @type {"latest"} */
export const RESUME_LATEST = 'latest'; // gemini's resume token; index alternatives intentionally not used

/**
 * @typedef {object} BuildGeminiArgsInput
 * @property {string} prompt - Passed via `-p <prompt>` (flag, not positional).
 * @property {string} model - Model id passed via `-m`.
 * @property {string} [resumeSessionId] - Treated identically to resumeLast; both collapse to `--resume latest`. The UUID-shaped session id cursed records is not accepted by gemini's `--resume`, which takes an index or "latest".
 * @property {boolean} [resumeLast] - When set (and resumeSessionId is not), invokes `--resume latest`.
 * @property {Record<string, string | undefined>} [extraEnv] - Env overrides merged into child env.
 */

/**
 * @typedef {object} GeminiInvocation
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string | undefined>} env
 */

/**
 * Build argv + env for a single `gemini -p` invocation.
 *
 * Argv shape (see `gemini --help`):
 *   - fresh:    gemini -p <prompt> -m <model> -o stream-json --yolo --skip-trust
 *   - resume:   gemini -p <prompt> -m <model> -o stream-json --yolo --skip-trust --resume latest
 *
 * Notes:
 *  - `--yolo` auto-approves tool actions; cursed's worktree isolation already provides the write boundary (mirrors the codex `--dangerously-bypass-approvals-and-sandbox` rationale).
 *  - `--skip-trust` trusts the workspace for the session; cursed-spawned dirs won't be in `~/.gemini/trustedFolders.json`.
 *  - Both `resumeSessionId` and `resumeLast` paths collapse to `--resume latest`. cursed records the stream's session id for telemetry; it's not round-tripped to gemini because gemini's `--resume` takes an integer index, not a UUID.
 *  - Executable resolution honors `CURSED_GEMINI_PATH`; falls through to `gemini` on PATH.
 *
 * @param {BuildGeminiArgsInput} input
 * @returns {GeminiInvocation}
 */
export function buildGeminiArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  /** @type {string[]} */
  const args = ['-p', prompt, '-m', model, '-o', 'stream-json', '--yolo', '--skip-trust'];
  if (resumeSessionId || resumeLast) {
    args.push(RESUME_FLAG, RESUME_LATEST);
  }
  return {
    command: process.env.CURSED_GEMINI_PATH || 'gemini',
    args,
    env: { ...process.env, ...extraEnv },
  };
}

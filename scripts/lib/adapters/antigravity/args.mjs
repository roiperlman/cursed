/**
 * @typedef {object} BuildAntigravityArgsInput
 * @property {string} prompt - Passed via `-p <prompt>`.
 * @property {string} model - Accepted for Adapter-contract parity and intentionally
 *   ignored: `agy` v1.0.0 has no command-line model flag. The selected model is the
 *   signed-in account default. cursed records the requested id on the RunRecord.
 * @property {string} [resumeSessionId] - When set, resumes that exact conversation
 *   via `--conversation <id>`. parseStream recovers a real conversation id, so this
 *   round-trips precisely. Takes precedence over resumeLast.
 * @property {boolean} [resumeLast] - When set (and resumeSessionId is not), resumes
 *   the most recent conversation via `--continue`.
 * @property {Record<string, string | undefined>} [extraEnv] - Env overrides merged
 *   into the child env.
 */

/**
 * @typedef {object} AntigravityInvocation
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string | undefined>} env
 */

/**
 * Build argv + env for a single non-interactive `agy -p` invocation.
 *
 * Argv shape (see `.cursed/antigravity-discovery.md`):
 *   - fresh:    agy -p <prompt> --dangerously-skip-permissions
 *   - resume:   agy -p <prompt> --dangerously-skip-permissions --conversation <id>
 *   - continue: agy -p <prompt> --dangerously-skip-permissions --continue
 *
 * Notes:
 *  - `--dangerously-skip-permissions` is required for non-interactive operation; without
 *    it `agy` stalls on tool-permission prompts. cursed's worktree isolation is the write
 *    boundary (mirrors the gemini `--yolo` / codex bypass-flag rationale).
 *  - `--sandbox` (agy's terminal-restriction sandbox) is appended only when the
 *    `CURSED_ANTIGRAVITY_SANDBOX` env var is set: in agy 1.0.0 it hangs ~2/3 of
 *    non-interactive runs, so it is an opt-in, not the default.
 *  - Executable resolution honors `CURSED_ANTIGRAVITY_PATH`; falls through to `agy` on PATH.
 *
 * @param {BuildAntigravityArgsInput} input
 * @returns {AntigravityInvocation}
 */
export function buildAntigravityArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  void model; // agy has no model flag — see typedef.
  /** @type {string[]} */
  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (process.env.CURSED_ANTIGRAVITY_SANDBOX) args.push('--sandbox');
  if (resumeSessionId) {
    args.push('--conversation', resumeSessionId);
  } else if (resumeLast) {
    args.push('--continue');
  }
  return {
    command: process.env.CURSED_ANTIGRAVITY_PATH || 'agy',
    args,
    env: { ...process.env, ...extraEnv },
  };
}

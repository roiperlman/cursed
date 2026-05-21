/** @type {"resume"} */
export const RESUME_SUBCOMMAND = 'resume'; // codex subcommand: `codex exec resume <id|--last> ...`
/** @type {"--last"} */
export const RESUME_LAST_FLAG = '--last'; // resume most recent session (positional id omitted)

// Codex sandboxes by default and requires --skip-git-repo-check unless the
// caller is inside a git repo. Cursed's worktree model already provides the
// write-isolation we need, so we bypass codex's sandbox at the call site to
// match cursor's "no sandbox" behavior. See .cursed/codex-discovery.md.
const BYPASS_SANDBOX_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const SKIP_GIT_CHECK_FLAG = '--skip-git-repo-check';

/**
 * @typedef {object} BuildCodexArgsInput
 * @property {string} prompt - Final positional argument passed to codex.
 * @property {string} model - Model id passed via `-m`.
 * @property {string} [resumeSessionId] - When set, invokes `exec resume <id>`.
 * @property {boolean} [resumeLast] - When true, invokes `exec resume --last`.
 * @property {Record<string, string | undefined>} [extraEnv] - Env overrides merged into child env.
 */

/**
 * @typedef {object} CodexInvocation
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string | undefined>} env
 */

/**
 * Build argv + env for a single `codex exec` invocation.
 *
 * Argv shape (see `codex exec --help` / `codex exec resume --help`):
 *   - fresh:    codex exec --json -m <model> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <prompt>
 *   - resume:   codex exec resume <id>  --json -m <model> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <prompt>
 *   - resume-last: codex exec resume --last --json -m <model> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox <prompt>
 *
 * `resume` is a subcommand of `exec`, not a flag — the SESSION_ID is positional
 * and must precede the prompt. Global options (--json, -m, --skip-*, etc.) are
 * accepted by both `exec` and `exec resume`.
 *
 * Working directory is supplied by the spawn `cwd`; we deliberately don't pass
 * `--cd` (the cursor adapter has the same convention).
 *
 * Executable resolution: honors `CURSED_CODEX_PATH`, falls through to whatever
 * `codex` resolves to on PATH. `probeSetup` handles the
 * /Applications/Codex.app fallback during availability checks; the spawn here
 * trusts whoever called into the adapter to have a working binary.
 *
 * @param {BuildCodexArgsInput} input
 * @returns {CodexInvocation}
 */
export function buildCodexArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  /** @type {string[]} */
  const args = ['exec'];
  if (resumeSessionId) {
    args.push(RESUME_SUBCOMMAND, resumeSessionId);
  } else if (resumeLast) {
    args.push(RESUME_SUBCOMMAND, RESUME_LAST_FLAG);
  }
  args.push('--json', '-m', model, SKIP_GIT_CHECK_FLAG, BYPASS_SANDBOX_FLAG);
  args.push(prompt);
  return {
    command: process.env.CURSED_CODEX_PATH || 'codex',
    args,
    env: { ...process.env, ...extraEnv },
  };
}

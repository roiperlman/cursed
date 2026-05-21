/** @type {"--resume"} */
export const RESUME_FLAG = '--resume'; // takes a chat/session id
/** @type {"--continue"} */
export const CONTINUE_FLAG = '--continue'; // boolean: continue most recent session

/**
 * @typedef {object} BuildCursorArgsInput
 * @property {string} prompt - Final positional argument passed to cursor-agent.
 * @property {string} model - Model id passed via `--model`.
 * @property {string} [resumeSessionId] - When set, adds `--resume <id>`.
 * @property {boolean} [resumeLast] - When true, adds `--continue`.
 * @property {Record<string, string | undefined>} [extraEnv] - Env overrides merged into child env.
 */

/**
 * @typedef {object} CursorInvocation
 * @property {"cursor-agent"} command
 * @property {string[]} args
 * @property {Record<string, string | undefined>} env
 */

/**
 * Builds argv + env for a single cursor-agent invocation.
 *
 * @param {BuildCursorArgsInput} input
 * @returns {CursorInvocation}
 */
export function buildCursorArgs({ prompt, model, resumeSessionId, resumeLast, extraEnv = {} }) {
  const args = ['--print', '--output-format', 'stream-json', '--force', '--model', model];
  if (resumeSessionId) {
    args.push(RESUME_FLAG, resumeSessionId);
  } else if (resumeLast) {
    args.push(CONTINUE_FLAG);
  }
  args.push(prompt);
  return {
    command: 'cursor-agent',
    args,
    env: { ...process.env, ...extraEnv },
  };
}

/**
 * @typedef {object} ParsedArgs
 * @property {string} subcommand - First positional argv token; required.
 * @property {Record<string, string | boolean>} flags - Parsed `--key=value` and `--key value` flags. Bare `--key` becomes `true`.
 * @property {string[]} positional - All non-flag tokens after the subcommand.
 */

/**
 * Minimal argv parser.
 *
 * Rules:
 *  - argv[0] is the subcommand (required).
 *  - Tokens starting with -- are flags:
 *      --key=value   → flags[key] = "value"
 *      --key value   → flags[key] = "value" (value = next token if it does not start with --)
 *      --key --next  → flags[key] = true (boolean)
 *  - Everything else is positional.
 *
 * @param {string[]} argv - Argv excluding `node` and the script path.
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  if (!argv || argv.length === 0) {
    throw new Error('subcommand required');
  }
  const [subcommand, ...rest] = argv;
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { subcommand, flags, positional };
}

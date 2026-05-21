import { readFile } from 'node:fs/promises';

const VAR_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

/**
 * Substitute `{{VAR}}` placeholders in a template with values from `vars`.
 * Unknown placeholders are left untouched.
 *
 * @param {string} template
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
export function substitute(template, vars) {
  return template.replace(VAR_RE, (match, key) => {
    return Object.hasOwn(vars, key) ? String(vars[key]) : match;
  });
}

/**
 * Read a prompt template from disk and substitute `{{VAR}}` placeholders.
 *
 * @param {string} path
 * @param {Record<string, unknown>} vars
 * @returns {Promise<string>}
 */
export async function loadPrompt(path, vars) {
  const raw = await readFile(path, 'utf8');
  return substitute(raw, vars);
}

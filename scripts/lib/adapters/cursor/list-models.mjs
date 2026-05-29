import { promisify } from 'node:util';
import { exec as cpExec } from 'node:child_process';
import catalog from '../../../../models.default.json' with { type: 'json' };

/** @typedef {import('../../types.d.ts').ModelInfo} ModelInfo */

const defaultExec = promisify(cpExec);

/**
 * Prefix → vendor mapping used when the static catalog doesn't list a
 * runtime-discovered slug. Ordered: longer prefixes first so `gpt-5-codex`
 * doesn't fall through to the generic `gpt-` rule before the specific one
 * is checked. Update when cursor-agent adds a new vendor namespace.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const VENDOR_BY_PREFIX = Object.freeze([
  ['composer-', 'cursor'],
  ['claude-', 'anthropic'],
  ['gemini-', 'google'],
  ['grok-', 'xai'],
  ['kimi-', 'moonshot'],
  ['glm-', 'zhipu'],
  ['codex-', 'openai'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
]);

/**
 * @param {string} slug
 * @param {Record<string, string[]> | undefined} providers
 * @returns {string | null}
 */
function inferVendor(slug, providers) {
  if (providers) {
    for (const [vendor, slugs] of Object.entries(providers)) {
      if (slugs.includes(slug)) return vendor;
    }
  }
  for (const [prefix, vendor] of VENDOR_BY_PREFIX) {
    if (slug.startsWith(prefix)) return vendor;
  }
  return null;
}

/**
 * @param {string} slug
 * @param {Record<string, string[]> | undefined} tiers
 * @returns {string | undefined}
 */
function inferTier(slug, tiers) {
  if (!tiers) return undefined;
  for (const [tier, slugs] of Object.entries(tiers)) {
    if (slugs.includes(slug)) return tier;
  }
  return undefined;
}

/**
 * Parse a `cursor-agent models` line. The CLI prints one model per line in
 * the format `<slug> - <display name>` with optional ` (current, default)`
 * trailer on the selected model. Non-conforming lines (headers, the trailing
 * usage tip) are skipped by the caller via the `null` return.
 *
 * @param {string} line
 * @returns {string | null}
 */
function parseSlug(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = /^([a-z0-9.-]+)\s+-\s+/i.exec(trimmed);
  if (!m) return null;
  const slug = m[1];
  // 'auto' is cursor-agent's meta-model that picks one of the real ones.
  // Routing has nothing to send it to, so leave it out.
  if (slug === 'auto') return null;
  return slug;
}

/**
 * @typedef {object} ListModelsOptions
 * @property {(cmd: string) => Promise<{ stdout: string }>} [exec]
 */

/**
 * Runtime model discovery for the cursor adapter. Shells out to
 * `cursor-agent models`, parses the plain-text output, and tags each slug
 * with its vendor (from the static catalog when listed, prefix heuristic
 * otherwise) and tier (only when the slug appears in the static catalog's
 * curated tier list).
 *
 * Returns `[]` on any failure — getModelSource interprets an empty list
 * as "fall back to the static catalog" so a broken cursor-agent install
 * doesn't blow up panel resolution.
 *
 * @param {ListModelsOptions} [options]
 * @returns {Promise<ModelInfo[]>}
 */
export async function listModels({ exec } = {}) {
  /** @type {string} */
  let stdout;
  try {
    if (exec) {
      const out = await exec('cursor-agent models');
      stdout = out.stdout || '';
    } else {
      const out = await defaultExec('cursor-agent models');
      stdout = out.stdout || '';
    }
  } catch {
    return [];
  }

  /** @type {ModelInfo[]} */
  const models = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const slug = parseSlug(line);
    if (!slug || seen.has(slug)) continue;
    const vendor = inferVendor(slug, catalog.providers);
    if (!vendor) continue;
    seen.add(slug);
    const tier = inferTier(slug, catalog.tiers);
    models.push(tier ? { slug, vendor, tier } : { slug, vendor });
  }
  return models;
}

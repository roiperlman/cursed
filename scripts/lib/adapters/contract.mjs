/**
 * Runtime validator for the Adapter contract declared in `../types.d.ts`.
 *
 * Called once per registered adapter from `./registry.mjs` (load-time gate),
 * and re-asserted by `test/unit/adapters/contract.test.mjs` so future
 * adapters (codex first) can't merge with a missing or mistyped field.
 *
 * The validator only checks declarative shape — it does NOT call
 * `buildArgs` / `parseStream` / `probeSetup` / `defaultCatalogPath`. Those
 * smoke-checks live in the contract test (Task 5), which can afford the
 * extra cost of touching the filesystem.
 */

/** @typedef {import('../types.d.ts').Adapter} Adapter */

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const REQUIRED_FUNCTIONS = /** @type {const} */ (['buildArgs', 'parseStream', 'probeSetup', 'defaultCatalogPath']);

/**
 * Throws a descriptive Error if `adapter` doesn't conform to the Adapter
 * contract. Caller-friendly: every message names the offending adapter
 * (when its `name` field is intact) and the failed predicate.
 *
 * @param {unknown} adapter
 * @returns {asserts adapter is Adapter}
 */
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('adapter: must be a non-null object');
  }
  const a = /** @type {Record<string, unknown>} */ (adapter);
  const label = typeof a.name === 'string' && a.name.length > 0 ? `adapter "${a.name}"` : 'adapter';

  if (typeof a.name !== 'string' || !NAME_PATTERN.test(a.name)) {
    throw new Error(`${label}: \`name\` must match ${NAME_PATTERN} (got ${JSON.stringify(a.name)})`);
  }
  if (a.api_version !== 1) {
    throw new Error(`${label}: \`api_version\` must be 1 (got ${JSON.stringify(a.api_version)})`);
  }
  if (!Array.isArray(a.vendors) || a.vendors.length === 0) {
    throw new Error(`${label}: \`vendors\` must be a non-empty string[]`);
  }
  for (const v of a.vendors) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${label}: \`vendors\` entries must be non-empty strings (got ${JSON.stringify(v)})`);
    }
  }
  if (new Set(a.vendors).size !== a.vendors.length) {
    throw new Error(`${label}: \`vendors\` contains duplicate entries`);
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof a[fn] !== 'function') {
      throw new Error(`${label}: \`${fn}\` must be a function`);
    }
  }
}

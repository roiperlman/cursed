import { getAdapter, listAdapters } from './adapters/registry.mjs';

/** @typedef {import('./types.d.ts').SetupResult} SetupResult */
/** @typedef {import('./types.d.ts').AllAdaptersSetupResult} AllAdaptersSetupResult */
/** @typedef {import('./types.d.ts').ProbeSetupOptions} ProbeSetupOptions */

/**
 * Probe all registered adapters in parallel and return a map of adapter name → SetupResult.
 *
 * @returns {Promise<AllAdaptersSetupResult>}
 */
export async function probeAllAdapters() {
  const entries = await Promise.all(
    listAdapters().map(async (name) => [name, await getAdapter(name).probeSetup()]),
  );
  return Object.fromEntries(entries);
}

/**
 * Probe the default (cursor) adapter for availability + auth.
 * Kept for unit tests and the CLI exit-code contract.
 *
 * @param {ProbeSetupOptions} [options]
 * @returns {Promise<SetupResult>}
 */
export async function probeSetup(options) {
  return getAdapter().probeSetup(options);
}

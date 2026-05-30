/**
 * Scenario: provider coverage
 *
 * Runs a minimal /cursed:advise call through each vendor. Model names are
 * derived at runtime from the production catalog (models.default.json) so
 * the test stays in sync with the codebase without manual updates.
 *
 * cursor-agent vendors: routed through the cursor adapter.
 * codex vendors: routed through the codex adapter when the model slug
 *   appears in ~/.codex/models_cache.json.
 * gemini vendors: routed through the gemini adapter; requires the `gemini`
 *   CLI on PATH and either an oauth_creds.json or an API key env var.
 * antigravity vendors: routed through the antigravity adapter; requires
 *   `agy` on PATH and the macOS keychain item the agy CLI persists
 *   (service `gemini`, account `antigravity`).
 *
 * Every cell asserts that `result.run.transcript_path` exists on disk and
 * its extension matches the adapter's declared `transcript_format`
 * (`.jsonl` for ndjson/absent, `.txt` for text) — this is the contract
 * regression check from ROI-68 (mirror file said `.jsonl` while agy
 * actually writes plain text).
 *
 * Cost: ~$0.005–0.02 per vendor. Run time: ~30–90s per vendor.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib, REPO_ROOT } from './helpers.mjs';
import { adapterForModel } from '../../scripts/lib/adapters/registry.mjs';

const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'models.default.json'), 'utf8'));

const fastSet = new Set(catalog.tiers.fast);

/** @type {{ vendor: string, model: string }[]} */
const CURSOR_VENDORS = Object.entries(catalog.providers).map(([vendor, models]) => ({
  vendor,
  model: models.find((m) => fastSet.has(m)) ?? models[models.length - 1],
}));

/** @type {{ vendor: string, model: string }[]} */
let CODEX_VENDORS = [];
try {
  const codexCatalog = JSON.parse(readFileSync(join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
  const slugs = (codexCatalog.models ?? []).map((/** @type {{ slug: string }} */ m) => m.slug);
  const preferred = slugs.find((s) => s === 'gpt-5.4-mini') ?? slugs[slugs.length - 1];
  if (preferred) CODEX_VENDORS = [{ vendor: 'openai', model: preferred }];
} catch {
  // Cache absent — codex not yet run on this machine; tests will be skipped.
}

/** @type {{ vendor: string, model: string }[]} */
let GEMINI_VENDORS = [];
try {
  execSync('which gemini', { stdio: 'ignore' });
  const authed =
    existsSync(join(os.homedir(), '.gemini', 'oauth_creds.json')) ||
    Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY);
  if (authed) {
    const geminiCatalogPath = fileURLToPath(new URL('../../scripts/lib/adapters/gemini/catalog.json', import.meta.url));
    const geminiCatalog = JSON.parse(readFileSync(geminiCatalogPath, 'utf8'));
    const fastModel = geminiCatalog.tiers?.fast?.[0];
    if (fastModel) GEMINI_VENDORS = [{ vendor: 'google', model: fastModel }];
  }
} catch {
  // gemini CLI not installed or not authenticated; tests will be skipped.
}

/** @type {{ vendor: string, model: string }[]} */
let ANTIGRAVITY_VENDORS = [];
try {
  execSync('which agy', { stdio: 'ignore' });
  // agy stores its OAuth token in the macOS keychain as a generic-password
  // item (service `gemini`, account `antigravity`). `security find-generic-password`
  // returns 0 when the item exists, 44 (errSecItemNotFound) when it doesn't.
  let keychainOk = false;
  try {
    execSync('security find-generic-password -s gemini -a antigravity', { stdio: 'ignore' });
    keychainOk = true;
  } catch {
    // Item absent or non-macOS host; skip.
  }
  if (keychainOk) {
    const agyCatalogPath = fileURLToPath(
      new URL('../../scripts/lib/adapters/antigravity/catalog.json', import.meta.url),
    );
    const agyCatalog = JSON.parse(readFileSync(agyCatalogPath, 'utf8'));
    const fastModel = agyCatalog.tiers?.fast?.[0];
    if (fastModel) ANTIGRAVITY_VENDORS = [{ vendor: 'google', model: fastModel }];
  }
} catch {
  // agy CLI not installed; tests will be skipped.
}

/**
 * Map an adapter's declared `transcript_format` to the file extension
 * `openTranscript` writes. `'text'` → `.txt`; anything else (`'ndjson'` or
 * absent, treated as the ndjson default) → `.jsonl`. Mirrors the logic in
 * scripts/lib/transcripts.mjs so the test stays in sync with the contract
 * declared by `Adapter.transcript_format`.
 *
 * @param {string | undefined} format
 * @returns {'.txt' | '.jsonl'}
 */
function expectedTranscriptExt(format) {
  return format === 'text' ? '.txt' : '.jsonl';
}

/**
 * Resolve the adapter for a model and assert that the run wrote a real
 * transcript file whose extension matches the adapter's declared
 * `transcript_format`. This is the ROI-68 regression check: an adapter that
 * declares `text` but the runtime still names the mirror file `.jsonl` (or
 * vice-versa) should fail here.
 *
 * @param {string} model
 * @param {{ transcript_path: string | null }} run
 */
async function assertTranscriptMatchesAdapterFormat(model, run) {
  expect(run.transcript_path, 'run.transcript_path must be set on completed runs').toBeTruthy();
  const transcriptPath = /** @type {string} */ (run.transcript_path);
  expect(existsSync(transcriptPath), `transcript file should exist on disk: ${transcriptPath}`).toBe(true);
  const adapter = await adapterForModel(model);
  const expectedExt = expectedTranscriptExt(adapter.transcript_format);
  expect(extname(transcriptPath)).toBe(expectedExt);
}

describe('e2e: provider coverage (cursor-agent)', () => {
  it.each(CURSOR_VENDORS)('$vendor ($model): advise completes with non-empty output', async ({ model }) => {
    const session = await startCursedSession(`e2e-provider-${model}`);
    try {
      const events = await runSlash(session.id, `/cursed:advise "One sentence: what is 2+2?" --models ${model}`, {
        timeoutMs: 120_000,
      });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      // cursor-agent free plans fall back to "auto" — accept either the
      // requested model or "auto" so the test passes on both plan tiers.
      expect([model, 'auto']).toContain(result.run.model);
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      await assertTranscriptMatchesAdapterFormat(model, result.run);
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 150_000);
});

describe('e2e: provider coverage (codex)', () => {
  it.each(CODEX_VENDORS)('$vendor ($model): advise completes with non-empty output', async ({ model }) => {
    const session = await startCursedSession(`e2e-codex-${model}`);
    try {
      const events = await runSlash(session.id, `/cursed:advise "One sentence: what is 2+2?" --models ${model}`, {
        timeoutMs: 120_000,
      });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      expect(result.run.model).toBe(model);
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      await assertTranscriptMatchesAdapterFormat(model, result.run);
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 150_000);
});

describe('e2e: provider coverage (gemini)', () => {
  it.each(GEMINI_VENDORS)('$vendor ($model): advise completes with non-empty output', async ({ model }) => {
    const session = await startCursedSession(`e2e-gemini-${model}`);
    try {
      const events = await runSlash(session.id, `/cursed:advise "One sentence: what is 2+2?" --models ${model}`, {
        timeoutMs: 120_000,
      });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      expect(result.run.model).toBe(model);
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      await assertTranscriptMatchesAdapterFormat(model, result.run);
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 150_000);
});

// `describe.skipIf` so the suite is collected as a skipped entry — vs. an
// empty `it.each([])` which vitest reports as "No test found in suite" and
// fails the file. ROI-111 DoD: the antigravity cell must skip cleanly when
// `agy` isn't installed.
describe.skipIf(ANTIGRAVITY_VENDORS.length === 0)('e2e: provider coverage (antigravity)', () => {
  it.each(ANTIGRAVITY_VENDORS)('$vendor ($model): advise completes with non-empty output', async ({ model }) => {
    const session = await startCursedSession(`e2e-agy-${model}`);
    try {
      const events = await runSlash(session.id, `/cursed:advise "One sentence: what is 2+2?" --models ${model}`, {
        timeoutMs: 180_000,
      });

      await expect(session).not.toHaveErrored(undefined, { wait: false });
      await expect(session).toHaveCalledTool('mcp__plugin_cursed_cursed__advise', undefined, { wait: false });

      /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
      const result = /** @type {any} */ (extractToolResult(events, 'mcp__plugin_cursed_cursed__advise'));
      expect(result.panel).toBe(false);
      expect(result.run.model).toBe(model);
      expect(result.run.status).toBe('completed');
      expect(result.run.text.trim().length).toBeGreaterThan(0);
      await assertTranscriptMatchesAdapterFormat(model, result.run);
    } finally {
      await lib.kill(session.id).catch(() => {});
    }
  }, 210_000);
});

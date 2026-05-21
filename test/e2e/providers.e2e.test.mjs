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
 *
 * Cost: ~$0.005–0.02 per vendor. Run time: ~30–90s per vendor.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { startCursedSession, runSlash, extractToolResult, lib, REPO_ROOT } from './helpers.mjs';

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
  const codexCatalog = JSON.parse(
    readFileSync(join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'),
  );
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
    const geminiCatalogPath = fileURLToPath(
      new URL('../../scripts/lib/adapters/gemini/catalog.json', import.meta.url),
    );
    const geminiCatalog = JSON.parse(readFileSync(geminiCatalogPath, 'utf8'));
    const fastModel = geminiCatalog.tiers?.fast?.[0];
    if (fastModel) GEMINI_VENDORS = [{ vendor: 'google', model: fastModel }];
  }
} catch {
  // gemini CLI not installed or not authenticated; tests will be skipped.
}

describe('e2e: provider coverage (cursor-agent)', () => {
  it.each(CURSOR_VENDORS)(
    '$vendor ($model): advise completes with non-empty output',
    async ({ model }) => {
      const session = await startCursedSession(`e2e-provider-${model}`);
      try {
        const events = await runSlash(
          session.id,
          `/cursed:advise "One sentence: what is 2+2?" --models ${model}`,
          { timeoutMs: 120_000 },
        );

        await expect(session).not.toHaveErrored(undefined, { wait: false });
        await expect(session).toHaveCalledTool(
          'mcp__plugin_cursed_cursed__advise',
          undefined,
          { wait: false },
        );

        /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
        const result = /** @type {any} */ (
          extractToolResult(events, 'mcp__plugin_cursed_cursed__advise')
        );
        expect(result.panel).toBe(false);
        // cursor-agent free plans fall back to "auto" — accept either the
        // requested model or "auto" so the test passes on both plan tiers.
        expect([model, 'auto']).toContain(result.run.model);
        expect(result.run.status).toBe('completed');
        expect(result.run.text.trim().length).toBeGreaterThan(0);
      } finally {
        await lib.kill(session.id).catch(() => {});
      }
    },
    150_000,
  );
});

describe('e2e: provider coverage (codex)', () => {
  it.each(CODEX_VENDORS)(
    '$vendor ($model): advise completes with non-empty output',
    async ({ model }) => {
      const session = await startCursedSession(`e2e-codex-${model}`);
      try {
        const events = await runSlash(
          session.id,
          `/cursed:advise "One sentence: what is 2+2?" --models ${model}`,
          { timeoutMs: 120_000 },
        );

        await expect(session).not.toHaveErrored(undefined, { wait: false });
        await expect(session).toHaveCalledTool(
          'mcp__plugin_cursed_cursed__advise',
          undefined,
          { wait: false },
        );

        /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
        const result = /** @type {any} */ (
          extractToolResult(events, 'mcp__plugin_cursed_cursed__advise')
        );
        expect(result.panel).toBe(false);
        expect(result.run.model).toBe(model);
        expect(result.run.status).toBe('completed');
        expect(result.run.text.trim().length).toBeGreaterThan(0);
      } finally {
        await lib.kill(session.id).catch(() => {});
      }
    },
    150_000,
  );
});

describe('e2e: provider coverage (gemini)', () => {
  it.each(GEMINI_VENDORS)(
    '$vendor ($model): advise completes with non-empty output',
    async ({ model }) => {
      const session = await startCursedSession(`e2e-gemini-${model}`);
      try {
        const events = await runSlash(
          session.id,
          `/cursed:advise "One sentence: what is 2+2?" --models ${model}`,
          { timeoutMs: 120_000 },
        );

        await expect(session).not.toHaveErrored(undefined, { wait: false });
        await expect(session).toHaveCalledTool(
          'mcp__plugin_cursed_cursed__advise',
          undefined,
          { wait: false },
        );

        /** @type {import('../../scripts/lib/types.d.ts').SoloRunResult | null} */
        const result = /** @type {any} */ (
          extractToolResult(events, 'mcp__plugin_cursed_cursed__advise')
        );
        expect(result.panel).toBe(false);
        expect(result.run.model).toBe(model);
        expect(result.run.status).toBe('completed');
        expect(result.run.text.trim().length).toBeGreaterThan(0);
      } finally {
        await lib.kill(session.id).catch(() => {});
      }
    },
    150_000,
  );
});

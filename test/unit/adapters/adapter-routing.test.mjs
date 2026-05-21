import { describe, it, expect } from 'vitest';
import { adapterForModel } from '../../../scripts/lib/adapters/registry.mjs';

const CODEX_SLUGS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'codex-auto-review'];
const CATALOG_JSON = JSON.stringify({
  fetched_at: '2026-05-16T00:00:00Z',
  models: CODEX_SLUGS.map((slug) => ({ slug })),
});

/** @param {string} content */
function makeReadFile(content) {
  return async () => content;
}

/** @param {string} [code] */
function makeReadFileThrow(code = 'ENOENT') {
  return async () => {
    const e = Object.assign(new Error(code), { code });
    throw e;
  };
}

describe('adapterForModel', () => {
  it('returns codex adapter when model slug is in the catalog', async () => {
    const adapter = await adapterForModel('gpt-5.4-mini', { _readFile: makeReadFile(CATALOG_JSON) });
    expect(adapter.name).toBe('codex');
  });

  it('returns cursor adapter when model is not in the catalog', async () => {
    const adapter = await adapterForModel('claude-4-sonnet', { _readFile: makeReadFile(CATALOG_JSON) });
    expect(adapter.name).toBe('cursor');
  });

  it('falls back to cursor when the catalog file is missing', async () => {
    const adapter = await adapterForModel('gpt-5.5', { _readFile: makeReadFileThrow('ENOENT') });
    expect(adapter.name).toBe('cursor');
  });

  it('falls back to cursor when the catalog JSON is malformed', async () => {
    const adapter = await adapterForModel('gpt-5.5', { _readFile: makeReadFile('not json {{{') });
    expect(adapter.name).toBe('cursor');
  });

  it('falls back to cursor when catalog has no models array', async () => {
    const adapter = await adapterForModel('gpt-5.5', { _readFile: makeReadFile('{}') });
    expect(adapter.name).toBe('cursor');
  });

  it.each(CODEX_SLUGS)('routes %s to codex', async (slug) => {
    const adapter = await adapterForModel(slug, { _readFile: makeReadFile(CATALOG_JSON) });
    expect(adapter.name).toBe('codex');
  });
});

const GEMINI_SLUGS = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
const GEMINI_CATALOG_JSON = JSON.stringify({
  version: '0.2',
  updated_at: '2026-05-20',
  tiers: { fast: ['gemini-3-flash-preview'], balanced: ['gemini-3.1-pro-preview'], reasoning: ['gemini-3.1-pro-preview'] },
  providers: { google: GEMINI_SLUGS },
});

describe('adapterForModel — gemini routing', () => {
  it('returns the gemini adapter for a slug in the gemini catalog', async () => {
    // Branch on path to avoid order-dependent call counting
    const _readFile = async (p) => {
      if (p.includes('models_cache')) return JSON.stringify({ models: [] }); // codex catalog miss
      return GEMINI_CATALOG_JSON;
    };
    const adapter = await adapterForModel('gemini-3-flash-preview', { _readFile });
    expect(adapter.name).toBe('gemini');
  });

  it.each(GEMINI_SLUGS)('routes %s to gemini', async (slug) => {
    const _readFile = async (p) => {
      if (p.includes('models_cache')) return JSON.stringify({ models: [] });
      return GEMINI_CATALOG_JSON;
    };
    const adapter = await adapterForModel(slug, { _readFile });
    expect(adapter.name).toBe('gemini');
  });

  it('falls back to cursor when gemini catalog is missing AND model not in codex catalog', async () => {
    const _readFile = async (_p) => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const adapter = await adapterForModel('gemini-3-flash-preview', { _readFile });
    expect(adapter.name).toBe('cursor');
  });
});

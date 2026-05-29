import { describe, it, expect } from 'vitest';
import { listModels } from '../../../scripts/lib/adapters/codex/list-models.mjs';

const SAMPLE_CACHE = {
  fetched_at: '2026-05-27T05:28:59Z',
  models: [
    { slug: 'gpt-5.5', visibility: 'list', priority: 9 },
    { slug: 'gpt-5.4', visibility: 'list', priority: 16 },
    { slug: 'gpt-5.4-mini', visibility: 'list', priority: 23 },
    { slug: 'gpt-5.3-codex', visibility: 'list', priority: 25 },
    { slug: 'gpt-5.2', visibility: 'list', priority: 29 },
    { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
  ],
};

/** @param {unknown} obj */
function makeReadFile(obj) {
  return async () => JSON.stringify(obj);
}

/** @param {string} code */
function makeReadFileThrow(code = 'ENOENT') {
  return async () => {
    throw Object.assign(new Error(code), { code });
  };
}

describe('codex listModels', () => {
  it('parses the models cache into ModelInfo[] tagged with vendor openai', async () => {
    const models = await listModels({ _readFile: makeReadFile(SAMPLE_CACHE), cachePath: '/test/cache.json' });
    expect(models).toEqual([
      { slug: 'gpt-5.5', vendor: 'openai' },
      { slug: 'gpt-5.4', vendor: 'openai' },
      { slug: 'gpt-5.4-mini', vendor: 'openai' },
      { slug: 'gpt-5.3-codex', vendor: 'openai' },
      { slug: 'gpt-5.2', vendor: 'openai' },
    ]);
  });

  it('filters out models with visibility: "hide"', async () => {
    const models = await listModels({ _readFile: makeReadFile(SAMPLE_CACHE), cachePath: '/test/cache.json' });
    expect(models.map((m) => m.slug)).not.toContain('codex-auto-review');
  });

  it('returns [] when the cache file is missing', async () => {
    const models = await listModels({ _readFile: makeReadFileThrow('ENOENT'), cachePath: '/no/such/file.json' });
    expect(models).toEqual([]);
  });

  it('returns [] when the cache file is malformed JSON', async () => {
    const _readFile = async () => 'not json {{{';
    const models = await listModels({ _readFile, cachePath: '/test/cache.json' });
    expect(models).toEqual([]);
  });

  it('returns [] when the cache has no models array', async () => {
    const models = await listModels({ _readFile: makeReadFile({}), cachePath: '/test/cache.json' });
    expect(models).toEqual([]);
  });

  it('skips entries missing a slug', async () => {
    const cache = { models: [{ visibility: 'list' }, { slug: 'gpt-5.5', visibility: 'list' }] };
    const models = await listModels({ _readFile: makeReadFile(cache), cachePath: '/test/cache.json' });
    expect(models).toEqual([{ slug: 'gpt-5.5', vendor: 'openai' }]);
  });

  it('deduplicates slug entries', async () => {
    const cache = {
      models: [
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
      ],
    };
    const models = await listModels({ _readFile: makeReadFile(cache), cachePath: '/test/cache.json' });
    expect(models).toEqual([{ slug: 'gpt-5.5', vendor: 'openai' }]);
  });
});

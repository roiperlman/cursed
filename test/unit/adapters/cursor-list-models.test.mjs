import { describe, it, expect } from 'vitest';
import { listModels } from '../../../scripts/lib/adapters/cursor/list-models.mjs';

/**
 * Realistic snippet of `cursor-agent models` output. Header line, slug lines
 * in `<slug> - <display>` form (some with `(current, default)` suffix), and
 * the usage tip at the end — all of which the parser must tolerate.
 */
const SAMPLE_OUTPUT = `Available models

auto - Auto (current)
composer-2.5-fast - Composer 2.5 Fast (default)
composer-2.5 - Composer 2.5
gpt-5.5-medium - GPT-5.5 1M
gpt-5.5-medium-fast - GPT-5.5 Fast
gpt-5.5-extra-high - GPT-5.5 1M Extra High
claude-opus-4-7-xhigh - Opus 4.7 1M
gemini-3.5-flash - Gemini 3.5 Flash
gemini-3.1-pro - Gemini 3.1 Pro
grok-4.3 - Grok 4.3 1M
kimi-k2.5 - Kimi K2.5
some-future-vendor-x - Unknown Future

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`;

/** @param {string} stdout */
function makeExec(stdout) {
  return async () => ({ stdout });
}

describe('cursor listModels', () => {
  it('parses cursor-agent models output into ModelInfo[]', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    const slugs = models.map((m) => m.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        'composer-2.5-fast',
        'composer-2.5',
        'gpt-5.5-medium',
        'gpt-5.5-medium-fast',
        'gpt-5.5-extra-high',
        'claude-opus-4-7-xhigh',
        'gemini-3.5-flash',
        'gemini-3.1-pro',
        'grok-4.3',
        'kimi-k2.5',
      ]),
    );
  });

  it('skips the auto meta-model', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    expect(models.map((m) => m.slug)).not.toContain('auto');
  });

  it('skips header and trailing tip lines', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    expect(models.map((m) => m.slug)).not.toContain('Available');
    expect(models.map((m) => m.slug)).not.toContain('Tip');
  });

  it('drops unclassifiable vendors (no static catalog entry, no prefix match)', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    expect(models.map((m) => m.slug)).not.toContain('some-future-vendor-x');
  });

  it('assigns vendor from prefix when not in the static catalog providers', async () => {
    // claude-opus-4-7-xhigh is in the static catalog providers.anthropic;
    // grok-4.3 is in providers.xai. Both should map to their respective
    // vendors regardless of which path (catalog lookup vs prefix) fired.
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    const byslug = new Map(models.map((m) => [m.slug, m]));
    expect(byslug.get('claude-opus-4-7-xhigh')?.vendor).toBe('anthropic');
    expect(byslug.get('grok-4.3')?.vendor).toBe('xai');
    expect(byslug.get('gemini-3.5-flash')?.vendor).toBe('google');
    expect(byslug.get('composer-2.5-fast')?.vendor).toBe('cursor');
    expect(byslug.get('kimi-k2.5')?.vendor).toBe('moonshot');
  });

  it('assigns the catalog-curated tier for tier members', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    const byslug = new Map(models.map((m) => [m.slug, m]));
    expect(byslug.get('composer-2.5-fast')?.tier).toBe('fast');
    expect(byslug.get('gpt-5.5-medium-fast')?.tier).toBe('fast');
    expect(byslug.get('gemini-3.5-flash')?.tier).toBe('fast');
    expect(byslug.get('composer-2.5')?.tier).toBe('balanced');
    expect(byslug.get('gpt-5.5-medium')?.tier).toBe('balanced');
    expect(byslug.get('gpt-5.5-extra-high')?.tier).toBe('reasoning');
    expect(byslug.get('grok-4.3')?.tier).toBe('reasoning');
    expect(byslug.get('gemini-3.1-pro')?.tier).toBe('reasoning');
  });

  it('omits tier for non-tier-member slugs', async () => {
    const models = await listModels({ exec: makeExec(SAMPLE_OUTPUT) });
    const byslug = new Map(models.map((m) => [m.slug, m]));
    // claude-opus-4-7-xhigh is in providers.anthropic but no tier (anthropic
    // entries are deliberately excluded from tier curation).
    expect(byslug.get('claude-opus-4-7-xhigh')?.tier).toBeUndefined();
    expect(byslug.get('kimi-k2.5')?.tier).toBeUndefined();
  });

  it('returns [] when cursor-agent fails (e.g. not installed)', async () => {
    const exec = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const models = await listModels({ exec });
    expect(models).toEqual([]);
  });

  it('returns [] for empty stdout', async () => {
    const models = await listModels({ exec: makeExec('') });
    expect(models).toEqual([]);
  });

  it('deduplicates repeated slugs in stdout', async () => {
    const stdout = `${SAMPLE_OUTPUT}composer-2.5-fast - Composer 2.5 Fast\n`;
    const models = await listModels({ exec: makeExec(stdout) });
    const occurrences = models.filter((m) => m.slug === 'composer-2.5-fast').length;
    expect(occurrences).toBe(1);
  });
});

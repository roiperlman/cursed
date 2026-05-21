import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_CONFIG, serializeConfig, resolveConfigPath } from '../../scripts/lib/config.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(__dirname, '..', 'fixtures', 'config');

describe('loadConfig', () => {
  it('returns defaults when config file does not exist', async () => {
    const cfg = await loadConfig('/nonexistent/path/config.toml');
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for an empty config', async () => {
    const cfg = await loadConfig(resolve(FIX, 'minimal.toml'));
    expect(cfg.defaults.silence_timeout_seconds).toBe(120);
    expect(cfg.defaults.total_timeout_seconds).toBe(1200);
  });

  it('applies global defaults from [defaults]', async () => {
    const cfg = await loadConfig(resolve(FIX, 'full.toml'));
    expect(cfg.defaults.silence_timeout_seconds).toBe(90);
    expect(cfg.defaults.total_timeout_seconds).toBe(900);
  });

  it('merges per-command overrides from [commands.<name>]', async () => {
    const cfg = await loadConfig(resolve(FIX, 'full.toml'));
    expect(cfg.commands.review.silence_timeout_seconds).toBe(150);
    expect(cfg.commands.review.total_timeout_seconds).toBe(900); // from [defaults]
    expect(cfg.commands.advise.silence_timeout_seconds).toBe(90); // from [defaults]
    expect(cfg.commands.advise.total_timeout_seconds).toBe(1800); // override
  });

  it('provides sensible command-specific defaults when no override exists', async () => {
    const cfg = await loadConfig('/nonexistent');
    expect(cfg.commands.advise.total_timeout_seconds).toBe(1800); // per master §6.4
    expect(cfg.commands.review.total_timeout_seconds).toBe(1200); // per master §6.1
  });

  it('loadConfig accepts [panel] and [panel.commands.<name>] blocks', async () => {
    const cfg = await loadConfig(resolve(FIX, 'panel.toml'));
    expect(cfg.panel.max_size).toBe(3);
    expect(cfg.panel.diversity).toBe(true);
    expect(cfg.panel.commands.review.panel_size).toBe(3);
    expect(cfg.panel.commands.plan_review.panel_size).toBe(1);
  });

  it('loadConfig defaults panel block when not present', async () => {
    const cfg = await loadConfig(resolve(FIX, 'minimal.toml'));
    expect(cfg.panel.max_size).toBe(3);
    expect(cfg.panel.diversity).toBe(true);
    expect(cfg.panel.commands).toEqual({
      review: { panel_size: 3, tier: 'balanced' },
      plan_review: { panel_size: 1, tier: 'reasoning' },
      advise: { panel_size: 1, tier: 'reasoning' },
      delegate: { panel_size: 1, tier: 'balanced' },
    });
  });

  it('defaults [delegate].dirty_tree to "refuse"', async () => {
    const cfg = await loadConfig('/nonexistent');
    expect(cfg.delegate.dirty_tree).toBe('refuse');
  });

  it('accepts [delegate].dirty_tree = "warn" from TOML', async () => {
    const cfg = await loadConfig(resolve(FIX, 'delegate-dirty.toml'));
    expect(cfg.delegate.dirty_tree).toBe('warn');
  });

  it('falls back to default on unknown [delegate].dirty_tree value', async () => {
    const tmp = resolve(FIX, 'delegate-dirty-bad.toml');
    // Write the bad fixture inline since the fixture dir is committed.
    const fs = await import('node:fs/promises');
    await fs.writeFile(tmp, '[delegate]\ndirty_tree = "lol"\n', 'utf8');
    try {
      const cfg = await loadConfig(tmp);
      expect(cfg.delegate.dirty_tree).toBe('refuse');
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });
});

describe('[delegate.background]', () => {
  it('defaults retention_days to 7 when block is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-cfg-'));
    try {
      const p = join(dir, 'config.toml');
      await writeFile(p, '', 'utf8');
      const cfg = await loadConfig(p);
      expect(cfg.delegate.background.retention_days).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honors a user-supplied retention_days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-cfg-'));
    try {
      const p = join(dir, 'config.toml');
      await writeFile(p, '[delegate.background]\nretention_days = 30\n', 'utf8');
      const cfg = await loadConfig(p);
      expect(cfg.delegate.background.retention_days).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive retention_days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-cfg-'));
    try {
      const p = join(dir, 'config.toml');
      await writeFile(p, '[delegate.background]\nretention_days = 0\n', 'utf8');
      await expect(loadConfig(p)).rejects.toThrow(/retention_days/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a string-typed retention_days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-cfg-'));
    try {
      const p = join(dir, 'config.toml');
      await writeFile(p, '[delegate.background]\nretention_days = "30"\n', 'utf8');
      await expect(loadConfig(p)).rejects.toThrow(/retention_days/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('adapters + panel filters', () => {
  it('defaults: adapters.default is cursor, enabled lists all registered', async () => {
    const cfg = await loadConfig('/nonexistent/config.toml');
    expect(cfg.adapters.default).toBe('cursor');
    expect(cfg.adapters.enabled).toEqual(expect.arrayContaining(['cursor', 'codex', 'gemini']));
    expect(cfg.panel.tier).toBe('reasoning');
    expect(cfg.panel.vendors).toEqual([]);
    expect(cfg.panel.commands.review.tier).toBe('balanced');
  });

  it('merges [adapters] and panel filter overrides from TOML', async () => {
    const tmp = join(tmpdir(), `cursed-cfg-${Date.now()}.toml`);
    await writeFile(
      tmp,
      [
        '[adapters]',
        'default = "codex"',
        'enabled = ["cursor", "codex"]',
        '[panel]',
        'tier = "fast"',
        'vendors = ["openai"]',
        '[panel.commands.review]',
        'tier = "reasoning"',
        'vendors = ["openai", "google"]',
      ].join('\n'),
    );
    try {
      const cfg = await loadConfig(tmp);
      expect(cfg.adapters.default).toBe('codex');
      expect(cfg.adapters.enabled).toEqual(['cursor', 'codex']);
      expect(cfg.panel.tier).toBe('fast');
      expect(cfg.panel.vendors).toEqual(['openai']);
      expect(cfg.panel.commands.review.tier).toBe('reasoning');
      expect(cfg.panel.commands.review.vendors).toEqual(['openai', 'google']);
    } finally {
      await rm(tmp, { force: true });
    }
  });

  it('rejects an unregistered adapter name', async () => {
    const tmp = join(tmpdir(), `cursed-cfg-bad-${Date.now()}.toml`);
    await writeFile(tmp, '[adapters]\ndefault = "bogus"\n');
    try {
      await expect(loadConfig(tmp)).rejects.toThrow(/config error.*bogus/);
    } finally {
      await rm(tmp, { force: true });
    }
  });

  it('rejects an unregistered adapter in a panel filter', async () => {
    const tmp = join(tmpdir(), `cursed-cfg-panelbad-${Date.now()}.toml`);
    await writeFile(tmp, '[panel]\nadapters = ["bogus"]\n');
    try {
      await expect(loadConfig(tmp)).rejects.toThrow(/config error.*bogus/);
    } finally {
      await rm(tmp, { force: true });
    }
  });
});

describe('serializeConfig', () => {
  it('round-trips: loadConfig(serializeConfig(c)) deep-equals c', async () => {
    const original = await loadConfig('/nonexistent/config.toml');
    original.adapters.default = 'codex';
    original.adapters.enabled = ['cursor', 'codex'];
    original.panel.tier = 'fast';
    original.panel.commands.review.vendors = ['openai', 'xai'];
    const tmp = join(tmpdir(), `cursed-ser-${Date.now()}.toml`);
    try {
      await writeFile(tmp, serializeConfig(original));
      const reloaded = await loadConfig(tmp);
      expect(reloaded).toEqual(original);
    } finally {
      await rm(tmp, { force: true });
    }
  });

  it('emits a header comment', () => {
    const cfg = DEFAULT_CONFIG;
    expect(serializeConfig(cfg)).toMatch(/^# cursed configuration/);
  });
});

describe('serializeConfig — panel_size undefined guard', () => {
  it('emits panel_size = 1 when panel command object lacks panel_size', async () => {
    const base = await loadConfig('/nonexistent/config.toml');
    // Inject a user-added panel command without panel_size (simulates partial merge).
    base.panel.commands['custom_cmd'] = /** @type {any} */ ({ tier: 'fast' });
    const out = serializeConfig(base);
    // Must not contain the literal string "panel_size = undefined"
    expect(out).not.toContain('panel_size = undefined');
    // Must contain the safe default instead
    expect(out).toContain('panel_size = 1');
  });

  it('round-trips via loadConfig when a command lacks panel_size', async () => {
    const base = await loadConfig('/nonexistent/config.toml');
    base.panel.commands['custom_cmd'] = /** @type {any} */ ({ tier: 'fast' });
    const toml = serializeConfig(base);
    const tmp = join(tmpdir(), `cursed-ps-guard-${Date.now()}.toml`);
    try {
      await writeFile(tmp, toml);
      // Should not throw — "panel_size = undefined" would be invalid TOML and fail.
      const reloaded = await loadConfig(tmp);
      expect(reloaded.panel.commands['custom_cmd']?.panel_size).toBe(1);
    } finally {
      await rm(tmp, { force: true });
    }
  });
});

describe('resolveConfigPath', () => {
  it('uses CLAUDE_PLUGIN_DATA when set', () => {
    expect(resolveConfigPath({ CLAUDE_PLUGIN_DATA: '/tmp/x' })).toBe('/tmp/x/config.toml');
  });
});

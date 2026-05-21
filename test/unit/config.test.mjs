import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';
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
      review: { panel_size: 3 },
      plan_review: { panel_size: 1 },
      advise: { panel_size: 1 },
      delegate: { panel_size: 1 },
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

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartupGC } from '../../scripts/mcp/cursed-mcp.mjs';
import { createJobState, jobStateDir, writeStatus } from '../../scripts/lib/jobs.mjs';

/**
 * @param {string} id
 * @param {Partial<import('../../scripts/lib/types.d.ts').JobMeta>} [overrides]
 * @returns {import('../../scripts/lib/types.d.ts').JobMeta}
 */
function makeMeta(id, overrides = {}) {
  return {
    version: 1,
    id,
    command: 'delegate',
    tier: 'balanced',
    model: 'auto-sonnet-4-6',
    vars: {},
    worktree: { path: `/tmp/wt/${id}`, branch: id, base: 'abc' },
    keep: false,
    started_at: new Date().toISOString(),
    silence_timeout_seconds: 120,
    total_timeout_seconds: 1800,
    retention_days: 7,
    ...overrides,
  };
}

describe('runStartupGC', () => {
  it('skips when last_gc.json is fresh (<24h)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cursed-gc-'));
    try {
      await writeFile(join(dataDir, 'last_gc.json'), JSON.stringify({ last_gc: new Date().toISOString() }), 'utf8');
      const r = await runStartupGC({ dataDir, retentionDays: 7, now: Date.now() });
      expect(r.ran).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs when last_gc.json is stale (>24h)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cursed-gc-'));
    try {
      const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      await writeFile(join(dataDir, 'last_gc.json'), JSON.stringify({ last_gc: stale }), 'utf8');
      const ws = join(dataDir, 'state', 'demo-aaaaaaaaaaaaaaaa');
      const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      await createJobState({
        workspaceDir: ws,
        id: 'old',
        meta: makeMeta('old', { started_at: longAgo }),
      });
      await writeStatus(jobStateDir(ws, 'old'), {
        status: 'completed',
        started_at: longAgo,
        finished_at: longAgo,
      });
      const r = await runStartupGC({ dataDir, retentionDays: 7, now: Date.now() });
      expect(r.ran).toBe(true);
      expect(r.totalDeleted).toBe(1);
      const lg = JSON.parse(await readFile(join(dataDir, 'last_gc.json'), 'utf8'));
      expect(Date.parse(lg.last_gc)).toBeGreaterThan(Date.parse(stale));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs and creates last_gc.json when absent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cursed-gc-'));
    try {
      const r = await runStartupGC({ dataDir, retentionDays: 7, now: Date.now() });
      expect(r.ran).toBe(true);
      await expect(stat(join(dataDir, 'last_gc.json'))).resolves.toBeDefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

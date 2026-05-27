import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeRunsDir,
  generateActiveRunId,
  registerActiveRun,
  unregisterActiveRun,
  listActiveRuns,
  isPidAlive,
} from '../../scripts/lib/active-runs.mjs';

/**
 * @param {string} id
 * @param {Partial<import('../../scripts/lib/active-runs.mjs').ActiveRunMeta>} [overrides]
 */
function makeMeta(id, overrides = {}) {
  return {
    id,
    command: 'review',
    model: 'grok-4',
    tier: 'reasoning',
    pid: process.pid,
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('active-runs', () => {
  it('generateActiveRunId returns a 16-hex-char string', () => {
    const id = generateActiveRunId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(generateActiveRunId()).not.toBe(id);
  });

  it('isPidAlive returns true for the current process and false for an invented pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // 2^30 is well outside any plausible OS pid; if it ever isn't, the test
    // still passes because the random pid would resolve to ESRCH almost always.
    expect(isPidAlive(2 ** 30)).toBe(false);
    expect(isPidAlive(/** @type {any} */ (null))).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it('register then list returns the entry; unregister removes it', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const meta = makeMeta('abc123');
      await registerActiveRun(ws, meta);
      const list1 = await listActiveRuns(ws);
      expect(list1).toHaveLength(1);
      expect(list1[0].id).toBe('abc123');
      expect(list1[0].command).toBe('review');

      await unregisterActiveRun(ws, 'abc123');
      const list2 = await listActiveRuns(ws);
      expect(list2).toHaveLength(0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('unregister is a no-op when the entry is missing', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      // No directory yet, no entry. Must not throw.
      await unregisterActiveRun(ws, 'never-existed');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('listActiveRuns drops entries whose pid is dead and deletes the files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      await registerActiveRun(ws, makeMeta('live', { pid: process.pid }));
      await registerActiveRun(ws, makeMeta('dead', { pid: 2 ** 30 }));

      const beforeFiles = await readdir(activeRunsDir(ws));
      expect(beforeFiles).toHaveLength(2);

      const list = await listActiveRuns(ws);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('live');

      // Stale entry was scrubbed.
      const afterFiles = await readdir(activeRunsDir(ws));
      expect(afterFiles).toEqual(['live.json']);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('listActiveRuns returns [] when the active-runs dir does not exist', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const list = await listActiveRuns(ws);
      expect(list).toEqual([]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('listActiveRuns drops unparseable JSON files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const dir = activeRunsDir(ws);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'broken.json'), 'not-json{', 'utf8');
      await registerActiveRun(ws, makeMeta('good'));

      const list = await listActiveRuns(ws);
      expect(list.map((r) => r.id)).toEqual(['good']);

      const remaining = await readdir(dir);
      expect(remaining).toEqual(['good.json']);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('listActiveRuns sorts newest first', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      await registerActiveRun(ws, makeMeta('old', { started_at: '2024-01-01T00:00:00.000Z' }));
      await registerActiveRun(ws, makeMeta('new', { started_at: '2025-01-01T00:00:00.000Z' }));
      await registerActiveRun(ws, makeMeta('mid', { started_at: '2024-06-01T00:00:00.000Z' }));

      const list = await listActiveRuns(ws);
      expect(list.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('listActiveRuns honors an injected isPidAlive probe', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      await registerActiveRun(ws, makeMeta('a', { pid: 100 }));
      await registerActiveRun(ws, makeMeta('b', { pid: 200 }));

      const list = await listActiveRuns(ws, { isPidAlive: (pid) => pid === 200 });
      expect(list.map((r) => r.id)).toEqual(['b']);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('register writes valid JSON with all expected fields', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'cursed-active-'));
    try {
      const meta = makeMeta('xyz', { transcript_path: '/tmp/foo.jsonl' });
      const path = await registerActiveRun(ws, meta);
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        id: 'xyz',
        command: 'review',
        model: 'grok-4',
        tier: 'reasoning',
        pid: process.pid,
        transcript_path: '/tmp/foo.jsonl',
      });
      expect(typeof parsed.started_at).toBe('string');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

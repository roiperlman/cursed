import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  workspaceSlug,
  dataDir,
  readState,
  writeState,
  setLastSession,
  stateFilePath,
} from '../../scripts/lib/state.mjs';

describe('state', () => {
  it('workspaceSlug is stable and deterministic for a given cwd', () => {
    const a = workspaceSlug('/Users/alice/personal/cursed');
    const b = workspaceSlug('/Users/alice/personal/cursed');
    expect(a).toBe(b);
    expect(a).toMatch(/^cursed-[0-9a-f]{16}$/);
  });

  it('workspaceSlug differs for different cwds with the same basename', () => {
    const a = workspaceSlug('/Users/alice/personal/cursed');
    const b = workspaceSlug('/Users/alice/elsewhere/cursed');
    expect(a).not.toBe(b);
  });

  it('dataDir honors CLAUDE_PLUGIN_DATA env var', () => {
    const dir = dataDir({ CLAUDE_PLUGIN_DATA: '/tmp/foo' });
    expect(dir).toBe('/tmp/foo');
  });

  it('dataDir falls back to TMPDIR/cursed-plugin when unset', () => {
    const dir = dataDir({ TMPDIR: '/tmp' });
    expect(dir).toBe('/tmp/cursed-plugin');
  });

  it('readState returns a default shape when file missing', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-state-'));
    try {
      const s = await readState(tmp);
      expect(s).toEqual({ version: 1, last_sessions: {} });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('writeState then readState round-trips', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-state-'));
    try {
      await writeState(tmp, { version: 1, last_sessions: { advise: 'cur_1' } });
      const s = await readState(tmp);
      expect(s.last_sessions.advise).toBe('cur_1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setLastSession updates the correct command key', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cursed-state-'));
    try {
      await setLastSession(tmp, 'advise', 'cur_abc');
      const s = await readState(tmp);
      expect(s.last_sessions.advise).toBe('cur_abc');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('readState legacy-tolerance', () => {
  it('discards a legacy `jobs` field from a v0.2 state.json without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-state-'));
    try {
      const legacy = {
        version: 1,
        last_sessions: { delegate: 's1' },
        jobs: [{ id: 'old', status: 'done', started_at: 'x' }],
      };
      await writeFile(stateFilePath(dir), JSON.stringify(legacy), 'utf8');
      const s = await readState(dir);
      expect(s.version).toBe(1);
      expect(s.last_sessions).toEqual({ delegate: 's1' });
      // @ts-expect-error legacy field should not be carried through
      expect(s.jobs).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeState emits clean StateShape after readState strips a legacy jobs field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursed-state-'));
    try {
      const legacy = { version: 1, last_sessions: { delegate: 's1' }, jobs: [{ id: 'old' }] };
      await writeFile(stateFilePath(dir), JSON.stringify(legacy), 'utf8');
      const loaded = await readState(dir);
      await writeState(dir, loaded);
      const raw = await readFile(stateFilePath(dir), 'utf8');
      expect(JSON.parse(raw)).toEqual({ version: 1, last_sessions: { delegate: 's1' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

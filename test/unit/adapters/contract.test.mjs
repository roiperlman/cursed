// Contract test — every entry in adapters/registry.mjs must conform.
//
// Today this iterates once (cursor). Phase 2 will add codex; if it drops
// a required field or returns the wrong shape, this suite breaks before
// the change can land.

import { describe, it, expect } from 'vitest';
import { isAbsolute } from 'node:path';
import { getAdapter, listAdapters } from '../../../scripts/lib/adapters/registry.mjs';
import { validateAdapter } from '../../../scripts/lib/adapters/contract.mjs';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

for (const name of listAdapters()) {
  describe(`adapter "${name}" contract`, () => {
    const adapter = getAdapter(name);

    it('passes validateAdapter (declarative shape)', () => {
      expect(() => validateAdapter(adapter)).not.toThrow();
    });

    it('name matches the lowercase-kebab pattern', () => {
      expect(adapter.name).toMatch(NAME_PATTERN);
    });

    it('api_version is 1 (Phase 1 contract)', () => {
      expect(adapter.api_version).toBe(1);
    });

    it('vendors is a non-empty string[] with no duplicates', () => {
      expect(Array.isArray(adapter.vendors)).toBe(true);
      expect(adapter.vendors.length).toBeGreaterThan(0);
      for (const v of adapter.vendors) expect(typeof v).toBe('string');
      expect(new Set(adapter.vendors).size).toBe(adapter.vendors.length);
    });

    it('buildArgs/parseStream/probeSetup/defaultCatalogPath are functions', () => {
      expect(typeof adapter.buildArgs).toBe('function');
      expect(typeof adapter.parseStream).toBe('function');
      expect(typeof adapter.probeSetup).toBe('function');
      expect(typeof adapter.defaultCatalogPath).toBe('function');
    });

    it('buildArgs({prompt, model}) returns AdapterInvocation shape', () => {
      const inv = adapter.buildArgs({ prompt: 'hello', model: 'm' });
      expect(typeof inv).toBe('object');
      expect(typeof inv.command).toBe('string');
      expect(inv.command.length).toBeGreaterThan(0);
      expect(Array.isArray(inv.args)).toBe(true);
      for (const a of inv.args) expect(typeof a).toBe('string');
      expect(typeof inv.env).toBe('object');
      expect(inv.env).not.toBeNull();
    });

    it('parseStream("") resolves to an empty ParsedRun', async () => {
      const r = await adapter.parseStream('');
      expect(r.text).toBe('');
      expect(r.errors).toEqual([]);
      expect(r.session_id).toBeNull();
      expect(Array.isArray(r.files_changed)).toBe(true);
      expect(Array.isArray(r.commands_run)).toBe(true);
    });

    it('parseStream(null) does not throw', async () => {
      await expect(adapter.parseStream(null)).resolves.toBeDefined();
    });

    it('parseStream(undefined) does not throw', async () => {
      await expect(adapter.parseStream(undefined)).resolves.toBeDefined();
    });

    // Contract only requires an absolute path. Whether the file exists on
    // disk is adapter-specific: cursor ships a bundled catalog (always
    // present); codex points at `~/.codex/models_cache.json`, which is
    // server-fetched and may not exist before first invocation.
    it('defaultCatalogPath() returns an absolute path', () => {
      const p = adapter.defaultCatalogPath();
      expect(typeof p).toBe('string');
      expect(isAbsolute(p)).toBe(true);
    });
  });
}

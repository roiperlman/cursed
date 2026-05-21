import { describe, it, expect } from 'vitest';
import { getAdapter, listAdapters, defaultAdapter } from '../../../scripts/lib/adapters/registry.mjs';

describe('adapters/registry', () => {
  it('listAdapters returns the registered names', () => {
    // Order matches the registration order in registry.mjs (cursor first,
    // then codex, then gemini). All adapters must be present.
    expect(listAdapters()).toEqual(['cursor', 'codex', 'gemini']);
  });

  it('getAdapter() with no arg returns the cursor adapter', () => {
    const a = getAdapter();
    expect(a.name).toBe('cursor');
  });

  it('getAdapter("cursor") returns the same instance', () => {
    expect(getAdapter('cursor')).toBe(getAdapter());
  });

  it('getAdapter("codex") returns the codex adapter', () => {
    expect(getAdapter('codex').name).toBe('codex');
  });

  it('getAdapter("gemini") returns the gemini adapter', () => {
    expect(getAdapter('gemini').name).toBe('gemini');
  });

  it('getAdapter("unknown") throws a descriptive error', () => {
    expect(() => getAdapter('nope')).toThrow(/unknown adapter: "nope".*registered: cursor, codex, gemini/);
  });

  it('defaultAdapter() is the cursor adapter', () => {
    expect(defaultAdapter().name).toBe('cursor');
    expect(defaultAdapter()).toBe(getAdapter('cursor'));
  });
});

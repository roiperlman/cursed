import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('smoke: setup subcommand', () => {
  it('invokes setup and returns parseable JSON', async () => {
    let stdout, exitCode;
    try {
      const res = await pexec('node', ['scripts/cursed.mjs', 'setup'], { cwd: REPO_ROOT });
      stdout = res.stdout;
      exitCode = 0;
    } catch (e) {
      const errAny = /** @type {{ stdout?: string; code?: number | string }} */ (e);
      stdout = errAny.stdout ?? '';
      exitCode = typeof errAny.code === 'number' ? errAny.code : 1;
    }
    expect(stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);
    // Result is a map of adapter name → SetupResult.
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    for (const adapterResult of Object.values(parsed)) {
      expect(typeof (/** @type {any} */ (adapterResult).available)).toBe('boolean');
      expect(typeof (/** @type {any} */ (adapterResult).authenticated)).toBe('boolean');
    }
    // exit code is 0, 3 (auth), or 4 (not installed) — all acceptable for smoke
    expect([0, 3, 4]).toContain(exitCode);
  }, 10_000);
});

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPTS } from '../../scripts/lib/prompts-inlined.gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/**
 * ROI-61 regression: the bundled worker (`scripts/cursed-job.bundled.mjs`)
 * used to compute the prompt path via `pluginRoot()` + `readFile()`, which
 * walked one directory too high once esbuild flattened the source tree —
 * so background `delegate --worktree …` failed immediately with
 * `ENOENT: no such file or directory, open '.../prompts/delegate.md'`.
 *
 * The fix inlines all prompts at build time. These structural assertions
 * keep the regression from sneaking back in: if anyone reintroduces a
 * filesystem read for `prompts/*.md` in the bundle, or strips the
 * inlined `PROMPTS` constant, this test fails.
 */
describe('bundled cursed-job worker — prompt resolution (ROI-61)', () => {
  it('does not resolve prompts/*.md from the filesystem', async () => {
    const bundle = await readFile(join(repoRoot, 'scripts/cursed-job.bundled.mjs'), 'utf8');
    // The defunct path joined `'prompts'` to `pluginRoot()` and read the
    // resulting file. Both signatures must be absent from the bundle.
    expect(bundle).not.toMatch(/join\([^)]*,\s*['"]prompts['"]/);
    expect(bundle).not.toMatch(/readFile\([^)]*['"]prompts\//);
  });

  it('inlines the prompt for every CommandName', async () => {
    const bundle = await readFile(join(repoRoot, 'scripts/cursed-job.bundled.mjs'), 'utf8');
    expect(bundle).toMatch(/var PROMPTS = \{/);
    for (const command of Object.keys(PROMPTS)) {
      // Key appears in the inlined object. esbuild may quote with " or '.
      expect(
        new RegExp(`["']${command}["']\\s*:`).test(bundle),
        `bundle is missing inlined PROMPTS["${command}"]`,
      ).toBe(true);
    }
    // Sanity: a distinctive substring from delegate.md survives inlining.
    expect(bundle).toContain('You are being handed a single scoped task');
  });
});

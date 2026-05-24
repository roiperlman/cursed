import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPaths, renderPrePassSection, runStructuralPrePass } from '../../scripts/lib/plan-paths.mjs';

/**
 * Build a tmp directory tree and populate the given relative paths as empty files.
 *
 * @param {string[]} relativeFiles
 * @returns {Promise<string>}
 */
async function makeTree(relativeFiles) {
  const root = await mkdtemp(join(tmpdir(), 'cursed-plan-paths-'));
  for (const rel of relativeFiles) {
    const abs = join(root, rel);
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    if (dir) await mkdir(dir, { recursive: true });
    await writeFile(abs, '');
  }
  return root;
}

/**
 * Build a basename-index stub without shelling out to git.
 *
 * @param {string[]} relativeFiles
 * @returns {Map<string, string[]>}
 */
function indexStub(relativeFiles) {
  /** @type {Map<string, string[]>} */
  const idx = new Map();
  for (const rel of relativeFiles) {
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    const arr = idx.get(base);
    if (arr) arr.push(rel);
    else idx.set(base, [rel]);
  }
  return idx;
}

describe('plan-paths · extractPaths', () => {
  it('extracts path-like tokens with a slash and allowed extension from prose', () => {
    const md = 'Modify `scripts/lib/foo.mjs` and also test/unit/foo.test.mjs to match.';
    expect(extractPaths(md)).toEqual(['scripts/lib/foo.mjs', 'test/unit/foo.test.mjs']);
  });

  it('extracts bare filenames from inline backticks (no slash needed)', () => {
    const md = 'Update `package.json` and `tsconfig.json`.';
    expect(extractPaths(md)).toEqual(['package.json', 'tsconfig.json']);
  });

  it('ignores bare filenames in prose without backticks', () => {
    const md = 'The package.json file gets a new dependency.';
    expect(extractPaths(md)).toEqual([]);
  });

  it('strips trailing punctuation', () => {
    const md = 'See scripts/lib/foo.mjs, then scripts/lib/bar.mjs.';
    expect(extractPaths(md)).toEqual(['scripts/lib/foo.mjs', 'scripts/lib/bar.mjs']);
  });

  it('drops a leading "./" from candidates', () => {
    const md = 'Look at `./scripts/lib/foo.mjs` for context.';
    expect(extractPaths(md)).toEqual(['scripts/lib/foo.mjs']);
  });

  it('deduplicates repeated paths', () => {
    const md = '`scripts/lib/foo.mjs` and again scripts/lib/foo.mjs in prose.';
    expect(extractPaths(md)).toEqual(['scripts/lib/foo.mjs']);
  });

  it('returns [] for empty / non-string input', () => {
    expect(extractPaths('')).toEqual([]);
    expect(extractPaths(/** @type {any} */ (null))).toEqual([]);
    expect(extractPaths(/** @type {any} */ (undefined))).toEqual([]);
  });

  it('returns [] for a plan with no paths', () => {
    expect(extractPaths('# Plan\n\nDo the thing, then validate it.\n')).toEqual([]);
  });

  it('accepts all supported extensions', () => {
    const md = [
      '`a.mjs`',
      '`b.ts`',
      '`c.tsx`',
      '`d.js`',
      '`e.jsx`',
      '`f.md`',
      '`g.json`',
      '`h.toml`',
      '`i.yaml`',
      '`j.yml`',
      '`k.py`',
      '`l.go`',
      '`m.rs`',
    ].join(' and ');
    expect(extractPaths(md)).toEqual([
      'a.mjs',
      'b.ts',
      'c.tsx',
      'd.js',
      'e.jsx',
      'f.md',
      'g.json',
      'h.toml',
      'i.yaml',
      'j.yml',
      'k.py',
      'l.go',
      'm.rs',
    ]);
  });
});

describe('plan-paths · runStructuralPrePass', () => {
  it('present-only plan — all paths classified present, warning null', async () => {
    const root = await makeTree(['scripts/lib/foo.mjs', 'package.json']);
    try {
      const result = await runStructuralPrePass({
        planText: '# Plan\n\nEdit `scripts/lib/foo.mjs` and tweak `package.json`.',
        repoRoot: root,
        _buildIndex: async () => indexStub(['scripts/lib/foo.mjs', 'package.json']),
      });
      expect(result.total).toBe(2);
      expect(result.present).toBe(2);
      expect(result.missing).toBe(0);
      expect(result.renamed_candidate).toBe(0);
      expect(result.warning).toBeNull();
      expect(result.paths.every((p) => p.status === 'present')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mixed plan — present + missing + renamed_candidate', async () => {
    const root = await makeTree(['scripts/lib/foo.mjs', 'scripts/lib/moved.mjs']);
    try {
      const plan = [
        'Edit `scripts/lib/foo.mjs`.',
        'Touch `scripts/old/moved.mjs`.',
        'Add `scripts/lib/missing.mjs`.',
      ].join('\n');
      const result = await runStructuralPrePass({
        planText: plan,
        repoRoot: root,
        _buildIndex: async () => indexStub(['scripts/lib/foo.mjs', 'scripts/lib/moved.mjs']),
      });
      expect(result.total).toBe(3);
      expect(result.present).toBe(1);
      expect(result.missing).toBe(1);
      expect(result.renamed_candidate).toBe(1);
      expect(result.warning).toBeNull();
      const moved = result.paths.find((p) => p.path === 'scripts/old/moved.mjs');
      expect(moved?.status).toBe('renamed_candidate');
      expect(moved?.candidates).toEqual(['scripts/lib/moved.mjs']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('all-missing plan — emits stale warning', async () => {
    const root = await makeTree([]);
    try {
      const result = await runStructuralPrePass({
        planText: 'Edit `scripts/lib/foo.mjs` and `scripts/lib/bar.mjs`.',
        repoRoot: root,
        _buildIndex: async () => indexStub([]),
      });
      expect(result.total).toBe(2);
      expect(result.present).toBe(0);
      expect(result.missing).toBe(2);
      expect(result.warning).toMatch(/plan may be stale — 2 of 2 referenced files were not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('plan with no paths — emits no-paths warning', async () => {
    const root = await makeTree([]);
    try {
      const result = await runStructuralPrePass({
        planText: '# Plan\n\nDo a refactor across the codebase.\n',
        repoRoot: root,
        _buildIndex: async () => indexStub([]),
      });
      expect(result.total).toBe(0);
      expect(result.warning).toMatch(/no recognizable file paths/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('plan with renamed files — flags renamed_candidate with candidate paths', async () => {
    const root = await makeTree(['src/util/helpers.ts']);
    try {
      const result = await runStructuralPrePass({
        planText: 'Edit `scripts/old/helpers.ts` to add a new helper.',
        repoRoot: root,
        _buildIndex: async () => indexStub(['src/util/helpers.ts']),
      });
      expect(result.total).toBe(1);
      expect(result.renamed_candidate).toBe(1);
      expect(result.paths[0]).toEqual({
        path: 'scripts/old/helpers.ts',
        status: 'renamed_candidate',
        candidates: ['src/util/helpers.ts'],
      });
      expect(result.warning).toMatch(/1 of 1 referenced files were not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads plan from disk when only planPath is supplied', async () => {
    const root = await makeTree(['scripts/lib/foo.mjs']);
    try {
      const planPath = join(root, 'plan.md');
      await writeFile(planPath, 'Edit `scripts/lib/foo.mjs`.');
      const result = await runStructuralPrePass({
        planPath: 'plan.md',
        repoRoot: root,
        _buildIndex: async () => indexStub(['scripts/lib/foo.mjs']),
      });
      expect(result.total).toBe(1);
      expect(result.present).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles unreadable plan gracefully (treats as empty)', async () => {
    const root = await makeTree([]);
    try {
      const result = await runStructuralPrePass({
        planPath: 'does-not-exist.md',
        repoRoot: root,
        _buildIndex: async () => indexStub([]),
      });
      expect(result.total).toBe(0);
      expect(result.warning).toMatch(/no recognizable file paths/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('plan-paths · renderPrePassSection', () => {
  it('renders a fallback section when no paths were extracted', () => {
    const out = renderPrePassSection({
      paths: [],
      total: 0,
      present: 0,
      missing: 0,
      renamed_candidate: 0,
      warning: 'plan may be stale — no recognizable file paths were found in the plan',
    });
    expect(out).toMatch(/## Structural pre-pass/);
    expect(out).toMatch(/No recognizable file paths/);
  });

  it('renders per-path status lines and the warning blockquote', () => {
    const out = renderPrePassSection({
      paths: [
        { path: 'scripts/lib/foo.mjs', status: 'present' },
        { path: 'scripts/old/moved.mjs', status: 'renamed_candidate', candidates: ['scripts/lib/moved.mjs'] },
        { path: 'scripts/lib/missing.mjs', status: 'missing' },
      ],
      total: 3,
      present: 1,
      missing: 1,
      renamed_candidate: 1,
      warning: null,
    });
    expect(out).toMatch(/## Structural pre-pass/);
    expect(out).toMatch(/present=1, missing=1, renamed_candidate=1/);
    expect(out).toMatch(/`scripts\/lib\/foo\.mjs` — present/);
    expect(out).toMatch(/`scripts\/old\/moved\.mjs` — \*\*renamed_candidate\*\*/);
    expect(out).toMatch(/`scripts\/lib\/moved\.mjs`/);
    expect(out).toMatch(/`scripts\/lib\/missing\.mjs` — \*\*missing\*\*/);
  });
});

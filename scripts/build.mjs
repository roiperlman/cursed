#!/usr/bin/env node
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, writeFile, chmod } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const SHEBANG = '#!/usr/bin/env node\n';
const REQUIRE_SHIM =
  `import { createRequire as __cursedCreateRequire } from 'node:module';\n` +
  `const require = __cursedCreateRequire(import.meta.url);\n`;

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
};

const entries = [
  {
    in: join(repoRoot, 'scripts/mcp/cursed-mcp.mjs'),
    out: join(repoRoot, 'scripts/mcp/cursed-mcp.bundled.mjs'),
  },
  {
    in: join(repoRoot, 'scripts/cursed-job.mjs'),
    out: join(repoRoot, 'scripts/cursed-job.bundled.mjs'),
  },
];

for (const { in: entry, out } of entries) {
  await build({ ...common, entryPoints: [entry], outfile: out });
  // esbuild preserves the source shebang at line 1. Replace it with a header
  // that adds the createRequire shim so transitive CJS deps that call
  // `require('node:stream')` etc. resolve at runtime.
  let body = await readFile(out, 'utf8');
  if (body.startsWith('#!')) body = body.slice(body.indexOf('\n') + 1);
  await writeFile(out, SHEBANG + REQUIRE_SHIM + body);
  await chmod(out, 0o755);
}

// Mirror package.json version into the two plugin-manifest files so the
// Claude Code-facing identifiers and the npm-style version stay in lockstep.
// Runs every build, so contributors and the release pipeline (which calls
// `npm run build` via @semantic-release/exec after @semantic-release/npm
// bumps package.json) both keep these aligned.
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
for (const file of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  const path = join(repoRoot, file);
  const obj = JSON.parse(await readFile(path, 'utf8'));
  if (obj.version !== pkg.version) {
    obj.version = pkg.version;
    await writeFile(path, `${JSON.stringify(obj, null, 2)}\n`);
  }
}

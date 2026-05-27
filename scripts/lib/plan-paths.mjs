import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/**
 * File extensions the path extractor recognizes.
 */
const ALLOWED_EXTENSIONS = ['mjs', 'ts', 'tsx', 'js', 'jsx', 'md', 'json', 'toml', 'yaml', 'yml', 'py', 'go', 'rs'];

const EXTENSION_GROUP = ALLOWED_EXTENSIONS.join('|');

/** Match a path-like token with at least one `/` in plain prose. */
const PROSE_PATH_RE = new RegExp(
  `(?:^|[^\\w./\\-_~@])([\\w./\\-_~@]*\\/[\\w./\\-_~@]*\\.(?:${EXTENSION_GROUP}))\\b`,
  'g',
);

/** Match the contents of an inline backtick code span. */
const BACKTICK_RE = /`([^`\n]+)`/g;

/** Match a bare filename with one of the allowed extensions (used inside backticks). */
const BARE_FILENAME_RE = new RegExp(`^[\\w.\\-_~@]+\\.(?:${EXTENSION_GROUP})$`);

/**
 * @typedef {'present' | 'missing' | 'renamed_candidate'} PrePassStatus
 */

/**
 * @typedef {object} PrePassPathEntry
 * @property {string} path - The path token as it appeared in the plan.
 * @property {PrePassStatus} status
 * @property {string[]} [candidates] - Repo-relative paths suggested when status is `renamed_candidate`.
 */

/**
 * @typedef {object} PrePassResult
 * @property {PrePassPathEntry[]} paths
 * @property {number} total
 * @property {number} present
 * @property {number} missing
 * @property {number} renamed_candidate
 * @property {string | null} warning - Top-level warning when all paths are missing or no paths detected.
 */

/**
 * Extract unique, likely file-path tokens from a markdown plan body.
 *
 * Two passes:
 *   1. Inline backtick code spans — accept any token that matches a bare
 *      filename with an allowed extension, or a slash-containing path.
 *   2. Plain prose — accept tokens with at least one `/` and an allowed extension.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractPaths(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  const push = (/** @type {string} */ tok) => {
    const cleaned = stripSurrounding(tok);
    if (!cleaned) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  // Pass 1: backtick code spans.
  for (const match of markdown.matchAll(BACKTICK_RE)) {
    const inner = match[1].trim();
    if (BARE_FILENAME_RE.test(inner) || hasAllowedExtension(inner)) {
      push(inner);
      continue;
    }
    for (const tok of inner.split(/\s+/)) {
      if (!tok) continue;
      if (BARE_FILENAME_RE.test(tok)) push(tok);
      else if (hasAllowedExtension(tok) && tok.includes('/')) push(tok);
    }
  }

  // Pass 2: plain prose — require at least one `/`.
  for (const match of markdown.matchAll(PROSE_PATH_RE)) {
    push(match[1]);
  }

  return out;
}

/**
 * @param {string} tok
 * @returns {boolean}
 */
function hasAllowedExtension(tok) {
  const dot = tok.lastIndexOf('.');
  if (dot < 0 || dot === tok.length - 1) return false;
  return ALLOWED_EXTENSIONS.includes(tok.slice(dot + 1).toLowerCase());
}

/**
 * Strip surrounding punctuation/quotes from a candidate token.
 *
 * @param {string} tok
 * @returns {string}
 */
function stripSurrounding(tok) {
  let t = tok;
  while (t.length > 0 && /[,;:!?]$/.test(t)) t = t.slice(0, -1);
  while (t.length > 0 && t.endsWith('.')) t = t.slice(0, -1);
  while (t.length > 0 && /^[,;:!?]/.test(t)) t = t.slice(1);
  // Drop leading "./" before stripping any surviving leading "." so we
  // don't turn "./scripts/foo.mjs" into "/scripts/foo.mjs".
  if (t.startsWith('./')) t = t.slice(2);
  while (t.length > 0 && t.startsWith('.')) t = t.slice(1);
  return t;
}

/**
 * @param {string} repoRoot
 * @param {string} p
 * @returns {string}
 */
function resolveAgainstRepo(repoRoot, p) {
  if (isAbsolute(p)) return p;
  return resolve(repoRoot, p);
}

/**
 * @typedef {Map<string, string[]>} BasenameIndex
 */

/**
 * Build a basename → [repo-relative paths] index via `git ls-files`.
 * Falls back to an empty index when not in a git repo.
 *
 * @param {string} repoRoot
 * @returns {Promise<BasenameIndex>}
 */
async function buildBasenameIndex(repoRoot) {
  /** @type {BasenameIndex} */
  const index = new Map();
  try {
    const { stdout } = await pexec('git', ['ls-files'], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const rel = line.trim();
      if (!rel) continue;
      const base = basename(rel);
      const arr = index.get(base);
      if (arr) arr.push(rel);
      else index.set(base, [rel]);
    }
  } catch {
    /* not a git repo or git missing — leave index empty */
  }
  return index;
}

/**
 * Classify a single path against the repo tree.
 *
 * @param {string} planPath
 * @param {{ repoRoot: string, index: BasenameIndex }} ctx
 * @returns {Promise<PrePassPathEntry>}
 */
async function classify(planPath, { repoRoot, index }) {
  const absolute = resolveAgainstRepo(repoRoot, planPath);
  const exists = await pathExists(absolute);
  if (exists) return { path: planPath, status: 'present' };

  const base = basename(planPath);
  const candidates = (index.get(base) ?? []).filter(
    (c) => normalizeForCompare(c) !== normalizeForCompare(toRepoRelative(repoRoot, planPath)),
  );
  if (candidates.length > 0) return { path: planPath, status: 'renamed_candidate', candidates };
  return { path: planPath, status: 'missing' };
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {string} p
 * @returns {string}
 */
function toRepoRelative(repoRoot, p) {
  const rel = relative(repoRoot, resolveAgainstRepo(repoRoot, p));
  return rel === '' ? '.' : rel;
}

/**
 * @param {string} p
 * @returns {string}
 */
function normalizeForCompare(p) {
  return p.replace(/\\/g, '/');
}

/**
 * @typedef {object} RunStructuralPrePassInput
 * @property {string} [planPath] - Plan file path; resolved against `repoRoot` when relative.
 * @property {string} [planText] - Pre-loaded plan body; takes precedence over `planPath`.
 * @property {string} repoRoot - Absolute path to the repo root for existence checks.
 * @property {(repoRoot: string) => Promise<BasenameIndex>} [_buildIndex] - Test injection point.
 * @property {(path: string, ctx: { repoRoot: string, index: BasenameIndex }) => Promise<PrePassPathEntry>} [_classify] - Test injection point.
 */

/**
 * Run the structural pre-pass against a plan file.
 *
 * @param {RunStructuralPrePassInput} input
 * @returns {Promise<PrePassResult>}
 */
export async function runStructuralPrePass({ planPath, planText, repoRoot, _buildIndex, _classify }) {
  let body = planText;
  if (body === undefined && planPath) {
    try {
      body = await readFile(resolveAgainstRepo(repoRoot, planPath), 'utf8');
    } catch {
      body = '';
    }
  }
  const paths = extractPaths(body ?? '');
  const buildIndex = _buildIndex ?? buildBasenameIndex;
  const classifyFn = _classify ?? classify;
  const index = paths.length > 0 ? await buildIndex(repoRoot) : new Map();

  /** @type {PrePassPathEntry[]} */
  const entries = [];
  for (const p of paths) {
    entries.push(await classifyFn(p, { repoRoot, index }));
  }
  const total = entries.length;
  const present = entries.filter((e) => e.status === 'present').length;
  const missing = entries.filter((e) => e.status === 'missing').length;
  const renamed = entries.filter((e) => e.status === 'renamed_candidate').length;

  let warning = null;
  if (total === 0) {
    warning = 'plan may be stale — no recognizable file paths were found in the plan';
  } else if (present === 0) {
    const notFound = total;
    warning = `plan may be stale — ${notFound} of ${total} referenced files were not found`;
  }

  return { paths: entries, total, present, missing, renamed_candidate: renamed, warning };
}

/**
 * Render the structural pre-pass section prepended to the review-plan prompt.
 *
 * @param {PrePassResult} prePass
 * @returns {string}
 */
export function renderPrePassSection(prePass) {
  const header = '## Structural pre-pass';
  if (!prePass || prePass.total === 0) {
    return [
      header,
      '',
      'No recognizable file paths were extracted from the plan. Treat any "the code does X" claim with extra suspicion.',
      '',
    ].join('\n');
  }
  const lines = [
    header,
    '',
    `Scanned ${prePass.total} referenced path(s): present=${prePass.present}, missing=${prePass.missing}, renamed_candidate=${prePass.renamed_candidate}.`,
    '',
  ];
  if (prePass.warning) lines.push(`> ${prePass.warning}`, '');
  for (const entry of prePass.paths) {
    if (entry.status === 'present') {
      lines.push(`- \`${entry.path}\` — present`);
    } else if (entry.status === 'missing') {
      lines.push(`- \`${entry.path}\` — **missing**`);
    } else {
      const cands = entry.candidates ?? [];
      const suffix = cands.length > 0 ? ` → candidates: ${cands.map((c) => `\`${c}\``).join(', ')}` : '';
      lines.push(`- \`${entry.path}\` — **renamed_candidate**${suffix}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

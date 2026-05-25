#!/usr/bin/env bash
# record-demo-panel.sh — run a real /cursed:review 3-model panel against the
# demo diff and format the result for the terminal recording.
#
# Usage:
#   asciinema rec docs/assets/demo-panel.cast \
#     --cols 100 --rows 32 \
#     --command "bash scripts/dev/record-demo-panel.sh"
#
# The demo branch (demo/batch-processor-review) is the reproducible diff source.
# Check it out before recording:
#   git checkout demo/batch-processor-review
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CURSED_CLI="$REPO_DIR/scripts/cursed.mjs"
TARGET="main...HEAD"
# Explicit models: one per provider — bypasses adapter-config filtering.
MODELS="gpt-5.4,gemini-3-flash-preview,antigravity-default"

# ── colour helpers ─────────────────────────────────────────────────────────
bold()   { printf '\e[1m%s\e[0m' "$*"; }
cyan()   { printf '\e[36m%s\e[0m' "$*"; }
green()  { printf '\e[32m%s\e[0m' "$*"; }
yellow() { printf '\e[33m%s\e[0m' "$*"; }
dim()    { printf '\e[2m%s\e[0m' "$*"; }
hr()     { printf '\e[2m%s\e[0m\n' "$(printf '─%.0s' $(seq 1 100))"; }

# ── simulate user invoking /cursed:review ───────────────────────────────────
printf '\n'
printf '  %s %s\n' "$(cyan '❯')" "$(bold '/cursed:review')"
sleep 0.8
printf '\n'
printf '  %s\n' "$(dim '  diff: docs/demo-diff/batch-processor.ts  (+37 lines)')"
printf '  %s\n' "$(dim '  models: gpt-5.4 · gemini-3-flash · antigravity-default')"
printf '  %s\n' "$(dim '  panel: 3   tier: balanced')"
printf '\n'
hr

# ── run the real panel ──────────────────────────────────────────────────────
cd "$REPO_DIR"
TMPFILE=$(mktemp /tmp/cursed-panel-XXXXX.json)
trap 'rm -f "$TMPFILE"' EXIT

# stderr goes to terminal so the user can see it if something goes wrong;
# stdout (the JSON result) is captured.
node "$CURSED_CLI" run \
  --command review \
  --vars "{\"SCOPE\":\"diff: $TARGET\",\"REPO_GUIDANCE\":\"\"}" \
  --tier balanced \
  --models "$MODELS" \
  2>/dev/null \
  > "$TMPFILE"

# ── format and print panel result ───────────────────────────────────────────
node --input-type=module <<'JSEOF' "$TMPFILE"
import { readFileSync } from 'node:fs';

const path = process.argv[1];
const raw  = readFileSync(path, 'utf8');
let result;
try { result = JSON.parse(raw); }
catch { process.stdout.write(raw + '\n'); process.exit(1); }

const bold   = s => `\x1b[1m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const green  = s => `\x1b[32m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const hr     = () => dim('─'.repeat(100)) + '\n';
const W      = process.stdout.write.bind(process.stdout);

if (!result.panel) {
  const r = result.run;
  W(bold(cyan('Result')) + '\n');
  W(r.status === 'completed' ? (r.text ?? '') : red(`[${r.error?.code}] ${r.error?.message}`));
  W('\n');
  process.exit(0);
}

const { runs, summary } = result;

for (const run of runs) {
  W('\n');
  W(hr());
  const label = run.model.replace('gemini-3-flash-preview', 'gemini-3-flash')
                         .replace('antigravity-default', 'antigravity');
  if (run.status === 'completed') {
    W(bold(`  ## ${cyan(label)}\n\n`));
    W((run.text ?? '').trim() + '\n');
  } else {
    W(bold(`  ## ${red(label)}`) + dim(`  [${run.error?.code ?? run.exit_reason}]\n`));
    W(dim(`  ${run.error?.message ?? ''}\n`));
  }
}

W('\n');
W(hr());

// ── convergence callout ────────────────────────────────────────────────────
const ok = runs.filter(r => r.status === 'completed');
if (ok.length >= 2) {
  const kwds = ['off-by-one', 'retry', 'back-off', 'backoff', 'throw lastError',
                'lastError', 'empty batch', 'attempt'];
  const hits = kwds.filter(kw =>
    ok.filter(r => (r.text ?? '').toLowerCase().includes(kw.toLowerCase())).length >= 2
  ).slice(0, 3);
  if (hits.length) {
    W('\n' + bold(green('  Convergence')) + dim(' — all models flagged: ') +
      hits.map(k => cyan(k)).join(dim(', ')) + '\n');
  }
}

// ── footer ─────────────────────────────────────────────────────────────────
const s = summary;
const dur = ((s.total_duration_ms ?? 0) / 1000).toFixed(1);
W('\n' + dim(`  ${s.models_completed}/${s.models_completed + s.models_failed} models ` +
  `· ${dur}s · ${s.total_tokens?.input ?? 0} in / ${s.total_tokens?.output ?? 0} out\n`));
JSEOF

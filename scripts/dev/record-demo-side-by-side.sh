#!/usr/bin/env bash
# record-demo-side-by-side.sh — capture a side-by-side asciinema cast of a
# real `/cursed:review` panel run. Two panes:
#
#   left  (90×32): scripts/dev/record-demo-panel.sh — the existing user-facing
#                  recording. Shows the typed command, the spinner wait, then
#                  the formatted panel result. Honest live terminal capture.
#
#   right (90×32): scripts/dev/watch-panel-streams.mjs — tails the per-model
#                  transcript jsonl files cursed writes during the run and
#                  renders a 3-pane "behind the scenes" view. Per-model
#                  status, elapsed, event/token counts, then the response
#                  text once each model completes.
#
# Coordination: both panes share a fresh CLAUDE_PLUGIN_DATA dir so the
# watcher can find the transcripts the left pane's panel run is writing.
# The orchestrator computes the workspace slug ahead of time using the same
# algorithm as scripts/lib/state.mjs (basename + sha256[0:16] of canonical
# cwd) so the watcher can be pointed at the runs dir before any file exists.
#
# Usage:
#   bash scripts/dev/record-demo-side-by-side.sh [OUT_CAST]
#
# Defaults: OUT_CAST=/tmp/cursed-demo-side-by-side.cast
#
# Pre-reqs: tmux, asciinema (v2 or v3), node, the cursed CLI configured.

set -euo pipefail

# ── resolve paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECORD_LEFT="$SCRIPT_DIR/record-demo-panel.sh"
WATCH_RIGHT="$SCRIPT_DIR/watch-panel-streams.mjs"

[[ -x "$RECORD_LEFT" || -f "$RECORD_LEFT" ]] || { echo "missing $RECORD_LEFT" >&2; exit 1; }
[[ -f "$WATCH_RIGHT" ]] || { echo "missing $WATCH_RIGHT" >&2; exit 1; }
command -v tmux >/dev/null      || { echo "tmux not installed" >&2; exit 1; }
command -v asciinema >/dev/null || { echo "asciinema not installed" >&2; exit 1; }
command -v node >/dev/null      || { echo "node not installed" >&2; exit 1; }

OUT_CAST="${1:-/tmp/cursed-demo-side-by-side.cast}"
MODELS="${MODELS:-gpt-5.4,gemini-3-flash-preview,gpt-5.4-mini}"

# Terminal dims. 180×32 is wide enough for two 90-col panes with a divider.
COLS="${COLS:-180}"
ROWS="${ROWS:-32}"

# ── prepare isolated CLAUDE_PLUGIN_DATA dir ────────────────────────────────
DEMO_DATA="$(mktemp -d -t cursed-demo-data-XXXXXX)"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -rf "$DEMO_DATA"' EXIT

# Match scripts/lib/state.mjs#workspaceSlug — basename + sha256(canonical cwd)[0:16]
canonical_cwd() { (cd "$1" && pwd -P); }
sha16() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}' | cut -c1-16; }
CWD_CANONICAL="$(canonical_cwd "$REPO_DIR")"
SLUG="$(basename "$CWD_CANONICAL")-$(sha16 "$CWD_CANONICAL")"
RUNS_DIR="$DEMO_DATA/state/$SLUG/runs"
mkdir -p "$RUNS_DIR"

SESSION="cursed-demo-$$"

# ── pane commands ──────────────────────────────────────────────────────────
# tmux does NOT inherit the parent shell's env by default — `tmux new-session`
# uses its own "global environment" instead. Inline CLAUDE_PLUGIN_DATA on
# every pane command so the left-pane CLI writes transcripts into the same
# dir the right-pane watcher is polling.
ENV_PREFIX="CLAUDE_PLUGIN_DATA=$(printf '%q' "$DEMO_DATA")"

# Left and right pane both `sleep N` after their primary work so that:
#   (a) the cast captures the final state for ~N seconds before tmux exits,
#   (b) one pane exiting doesn't immediately collapse the other to fullscreen.
# 10s is enough for a viewer to read the convergence callout + footer and the
# 3 BTS panes side by side; longer just bloats the cast.
LINGER_SECS="${LINGER_SECS:-10}"

LEFT_CMD="$ENV_PREFIX bash $(printf '%q' "$RECORD_LEFT"); sleep $LINGER_SECS"
RIGHT_CMD="$ENV_PREFIX node $(printf '%q' "$WATCH_RIGHT") watch $(printf '%q' "$RUNS_DIR") $(printf '%q' "$MODELS"); sleep $LINGER_SECS"

# ── start tmux session, then attach under asciinema rec ────────────────────
# Pre-create the tmux session detached so we can split panes before
# asciinema starts recording.
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "$LEFT_CMD"
tmux split-window -t "$SESSION":0.0 -h "$RIGHT_CMD"
tmux select-pane  -t "$SESSION":0.0
# When the last pane in the window exits, the window/session is destroyed —
# which causes the asciinema rec attach to return.
tmux set-option -t "$SESSION" remain-on-exit off >/dev/null
# Hide tmux's bottom status line so the cast looks like a plain terminal,
# and drop pane-divider colours so the split feels neutral.
tmux set-option -t "$SESSION" status off >/dev/null
tmux set-option -t "$SESSION" pane-border-style 'fg=colour238' >/dev/null
tmux set-option -t "$SESSION" pane-active-border-style 'fg=colour238' >/dev/null

# Format flag for asciinema. v3.x defaults to asciicast-v3; agg accepts both
# but the existing demo asset (docs/assets/demo-panel.cast) is v2 and
# termtosvg only handles v2. Stay on v2 for consistency.
FORMAT_FLAG=()
if asciinema rec --help 2>&1 | grep -q -- '--output-format'; then
  FORMAT_FLAG=(--output-format asciicast-v2)
fi

echo ":: recording to $OUT_CAST  (CLAUDE_PLUGIN_DATA=$DEMO_DATA)" >&2
asciinema rec \
  --headless \
  --overwrite \
  --window-size "${COLS}x${ROWS}" \
  "${FORMAT_FLAG[@]}" \
  --command "tmux attach -t $SESSION" \
  "$OUT_CAST"

echo ":: done. cast=$OUT_CAST" >&2
echo ":: next: agg $OUT_CAST ${OUT_CAST%.cast}.gif" >&2

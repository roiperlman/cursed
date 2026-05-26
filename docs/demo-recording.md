# Recording the README hero demo

The hero animation in [`README.md`](../README.md) is an unedited capture of
a real `/cursed:review` 3-model panel — no synthesized typing, no scripted
spinner, no post-hoc text streaming. This doc covers how the recording flow
is wired and how to re-record after a model change.

## Layout

The cast is a tmux session split vertically, then captured with `asciinema rec`:

```
┌─ LEFT (90×32) ─────────────────────┬─ RIGHT (90×32) ────────────────────┐
│ scripts/dev/record-demo-panel.sh   │ scripts/dev/watch-panel-streams.mjs│
│                                    │                                    │
│ Live terminal:                     │ "Behind the scenes":               │
│   ❯ /cursed:review                 │ 3 sub-panes, one per model,        │
│   ⠋ running 3 models in parallel   │ rendered from the per-model        │
│   …                                │ transcripts cursed writes during   │
│   ## gpt-5.4                       │ the run. Shows real-time:          │
│   <real review text>               │   – status (waiting/running/done)  │
│   ## gemini-3-flash                │   – elapsed                        │
│   <real review text>               │   – event/tool counts              │
│   ## gpt-5.4-mini                  │   – token usage                    │
│   <real review text>               │   – last event label               │
│   ✓ Convergence — …                │   – response text on completion    │
│   3/3 models · …                   │                                    │
└────────────────────────────────────┴────────────────────────────────────┘
```

Both panes share the same `CLAUDE_PLUGIN_DATA` dir. The cursed CLI on the
left writes per-model transcripts under `<dir>/state/<slug>/runs/<date>/`;
the watcher on the right tails those files. Coordination is filesystem-only;
no IPC.

## Files

| File | Role |
|---|---|
| `scripts/dev/record-demo-side-by-side.sh` | Orchestrator. Spawns tmux + asciinema, computes the workspace slug, manages the env var inheritance quirk. |
| `scripts/dev/record-demo-panel.sh` | Left pane. Invokes the real `cursed.mjs run --command review` and pretty-prints the result. |
| `scripts/dev/watch-panel-streams.mjs` | Right pane. Tails per-model transcript jsonl files and renders the 3-pane BTS view. Also has a `replay` mode for visual iteration without model calls. |
| `docs/demo-diff/batch-processor.ts` | The planted-bug fixture the panel reviews. |
| `docs/assets/demo-panel.cast` | The committed recording (asciicast v2). |
| `docs/assets/demo-panel.gif` | GIF rendered from the cast via `agg`. |

## Re-recording

```bash
# 1. Capture (real model calls — ~$0.10, ~3 min wall time)
bash scripts/dev/record-demo-side-by-side.sh docs/assets/demo-panel.cast

# 2. Render GIF
agg --font-size 12 --theme github-dark --idle-time-limit 3 \
    docs/assets/demo-panel.cast docs/assets/demo-panel.gif

# 3. Verify the README link still resolves and the image renders inline.
```

Tunables (env vars on the orchestrator):

- `MODELS=gpt-5.4,gemini-3-flash-preview,gpt-5.4-mini` — model list. Must
  match what your cursed config can resolve.
- `LINGER_SECS=10` — how long both panes hold their final state before
  exiting. Trade-off: longer = more time to read at the end, but a longer
  GIF.
- `COLS=180`, `ROWS=32` — terminal dimensions. 180 wide gives two 90-col
  panes; 32 rows gives 10 rows per sub-pane in the BTS view.

## Why not the synthesized cast?

A prior version of this asset (see git history for the deleted
`scripts/dev/build-demo-cast.py`) reconstructed the cast from a saved
result JSON by faking the typed command and condensing the spinner wait
into a few seconds. The model text was real, but the visual rhythm was
staged — the on-screen timing did not match the real run.

The current flow captures the actual terminal session. Trade-offs:

- The cast runs about as long as the real panel (~1–3 min, capped by the
  slowest model). `agg --idle-time-limit` is the easiest knob if you need
  to shrink it.
- The right pane's per-model bodies only fill in after each model completes
  — cursor-agent and codex emit the assistant message as one event at the
  end (no token-by-token streaming on the wire). Gemini does stream deltas;
  the watcher accumulates them via the `append: true` extractor path.

## Iterating without burning real model calls

`watch-panel-streams.mjs` has a `replay` mode that synthesizes a flow from
a saved panel result JSON. Useful when tweaking the renderer:

```bash
node scripts/dev/watch-panel-streams.mjs replay docs/assets/demo-panel-result.json
```

The `replay` path mocks the lifecycle (start → thinking ticks → response →
done) at a condensed pace. The text it streams is real (from the JSON);
the timing is not.

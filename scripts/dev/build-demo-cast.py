#!/usr/bin/env python3
"""
build-demo-cast.py — convert a real /cursed:review panel JSON result into
an asciinema v3 .cast file for the README demo.

The cast has three phases:
  1. Intro preamble  (~3s) — shows the /cursed:review invocation
  2. Spinner wait    (~4s) — simulates models running concurrently
  3. Results output  (~28s) — streams per-model findings + footer

Total: ~35s, within the 30–45s acceptance criterion.

Usage:
    python3 scripts/dev/build-demo-cast.py \
        /tmp/demo-panel-real-result.json \
        docs/assets/demo-panel.cast
"""

import json
import sys
import time
import textwrap

COLS = 90
ROWS = 26

# ANSI helpers
BOLD   = lambda s: f"\x1b[1m{s}\x1b[0m"
CYAN   = lambda s: f"\x1b[36m{s}\x1b[0m"
GREEN  = lambda s: f"\x1b[32m{s}\x1b[0m"
DIM    = lambda s: f"\x1b[2m{s}\x1b[0m"
RESET  = "\x1b[0m"
HR     = DIM("─" * 98) + "\r\n"

def make_header(ts):
    return {
        "version": 3,
        "width": COLS,
        "height": ROWS,
        "timestamp": int(ts),
        "title": "/cursed:review — 3-model panel",
        "env": {"TERM": "xterm-256color", "SHELL": "/bin/zsh"},
    }

def emit(events, t, text):
    """Append an output event at time t."""
    events.append([round(t, 3), "o", text])
    return t

def type_text(events, t, text, cps=22):
    """Stream text character-by-character at ~cps chars/second."""
    for ch in text:
        events.append([round(t, 3), "o", ch])
        t += 1.0 / cps
    return t

def stream_text(events, t, text, chars_per_batch=4, batch_delay=0.04, target_seconds=None):
    """Stream text in small batches (faster than typing).
    For large texts, automatically upscale batch size to keep total events low.
    If target_seconds is given, batch_delay is scaled so total streaming takes that long.
    """
    # Cap total events per block to keep SVG file size reasonable (~2MB target)
    max_events = 25
    total_chars = len(text)
    if total_chars > max_events * chars_per_batch:
        chars_per_batch = max(chars_per_batch, total_chars // max_events)
    n_batches = max(1, (len(text) + chars_per_batch - 1) // chars_per_batch)
    if target_seconds is not None:
        batch_delay = target_seconds / n_batches
    for i in range(0, len(text), chars_per_batch):
        chunk = text[i:i+chars_per_batch]
        events.append([round(t, 3), "o", chunk])
        t += batch_delay
    return t

def spinner_wait(events, t, duration=4.0, label="running 3 models in parallel"):
    """Show an animated spinner for `duration` seconds."""
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    interval = 0.25
    steps = int(duration / interval)
    # Print label on first frame
    first = True
    for i in range(steps):
        frame = frames[i % len(frames)]
        if first:
            line = f"  {CYAN(frame)} {DIM(label)}"
            first = False
        else:
            line = f"\r  {CYAN(frame)} {DIM(label)}"
        events.append([round(t, 3), "o", line])
        t += interval
    # Clear the spinner line
    events.append([round(t, 3), "o", "\r" + " " * (len(label) + 6) + "\r"])
    t += 0.05
    return t


def build_cast(result_path, out_path):
    with open(result_path) as f:
        result = json.load(f)

    runs    = result.get("runs", [])
    summary = result.get("summary", {})
    events  = []
    t       = 0.0

    # ── Phase 1: Intro preamble ─────────────────────────────────────────────
    t = emit(events, t, "\r\n")
    t += 0.3

    # Show the command being typed
    prompt_prefix = "  " + CYAN("❯") + " "
    t = emit(events, t, prompt_prefix)
    t += 0.1
    t = type_text(events, t, "/cursed:review", cps=14)
    t += 0.5
    t = emit(events, t, "\r\n\r\n")
    t += 0.15

    # Metadata lines
    models_str = " · ".join(
        r["model"].replace("gemini-3-flash-preview", "gemini-3-flash")
                  .replace("gpt-5.4-mini", "gpt-5.4-mini")
        for r in runs
    )
    meta_lines = [
        f"  {DIM('diff:   docs/demo-diff/batch-processor.ts  (+37 lines)')}",
        f"  {DIM(f'models: {models_str}')}",
        f"  {DIM('panel:  3   tier: balanced')}",
    ]
    for line in meta_lines:
        t = emit(events, t, line + "\r\n")
        t += 0.12
    t += 0.2
    t = emit(events, t, HR)
    t += 0.3

    # ── Phase 2: Spinner ────────────────────────────────────────────────────
    t = spinner_wait(events, t, duration=5.0)
    t += 0.3

    # ── Phase 3: Per-model results ──────────────────────────────────────────
    for run in runs:
        model_label = (run["model"]
                       .replace("gemini-3-flash-preview", "gemini-3-flash")
                       .replace("gpt-5.4-mini", "gpt-5.4-mini"))
        t = emit(events, t, "\r\n" + HR)
        t += 0.15
        heading = BOLD(f"  ## {CYAN(model_label)}")
        t = emit(events, t, heading + "\r\n\r\n")
        t += 0.15

        if run.get("status") == "completed":
            raw = (run.get("text") or "").strip()
            # Keep only first ~700 chars to bound SVG size
            if len(raw) > 700:
                raw = raw[:700].rsplit("\n", 1)[0] + "\n  …"
            # Wrap long lines to COLS-4
            wrapped = []
            for para in raw.split("\n"):
                if len(para) <= COLS - 4:
                    wrapped.append(para)
                else:
                    wrapped.extend(textwrap.wrap(para, width=COLS - 4))
            text_out = "\r\n".join("  " + ln for ln in wrapped) + "\r\n"
            # Stream the text — aim for ~8.5 seconds per model so total cast hits 30-45s
            total_chars = len(text_out)
            chars_per_batch = max(4, total_chars // 200)
            t = stream_text(
                events, t, text_out,
                chars_per_batch=chars_per_batch,
                target_seconds=8.5,
            )
        else:
            err = run.get("error", {})
            t = emit(events, t, f"  {DIM('[' + err.get('code','error') + '] ' + err.get('message',''))}\r\n")
            t += 0.1
        t += 0.3

    t = emit(events, t, "\r\n" + HR)
    t += 0.2

    # ── Convergence callout ─────────────────────────────────────────────────
    ok_runs = [r for r in runs if r.get("status") == "completed"]
    if len(ok_runs) >= 2:
        kwds = ["off-by-one", "retry", "back-off", "backoff", "lastError", "empty batch", "attempt"]
        hits = [kw for kw in kwds
                if sum(1 for r in ok_runs if kw.lower() in (r.get("text") or "").lower()) >= 2][:3]
        if hits:
            convergence_line = (
                "\r\n"
                + BOLD(GREEN("  ✓ Convergence"))
                + DIM(" — all models flagged: ")
                + DIM(", ").join(CYAN(h) for h in hits)
                + "\r\n"
            )
            t = emit(events, t, convergence_line)
            t += 0.4

    # ── Footer ──────────────────────────────────────────────────────────────
    n_ok   = summary.get("models_completed", len(ok_runs))
    n_fail = summary.get("models_failed", 0)
    dur    = summary.get("total_duration_ms", 0) / 1000
    tok_in = summary.get("total_tokens", {}).get("input", 0)
    tok_out= summary.get("total_tokens", {}).get("output", 0)
    footer = (
        "\r\n"
        + DIM(f"  {n_ok}/{n_ok + n_fail} models  ·  {dur:.1f}s  ·  "
              f"{tok_in:,} in / {tok_out:,} out")
        + "\r\n\r\n"
    )
    t = emit(events, t, footer)
    t += 0.5

    print(f"Cast duration: {t:.1f}s  events: {len(events)}", file=sys.stderr)

    # ── Write .cast ─────────────────────────────────────────────────────────
    with open(out_path, "w") as out:
        out.write(json.dumps(make_header(time.time())) + "\n")
        for ev in events:
            out.write(json.dumps(ev) + "\n")

    print(f"Wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <result.json> <out.cast>", file=sys.stderr)
        sys.exit(1)
    build_cast(sys.argv[1], sys.argv[2])

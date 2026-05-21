#!/usr/bin/env bash
# scripts/dev/capture-fixture.sh — dev-only helper to capture raw cursor-agent output.
# Usage: scripts/dev/capture-fixture.sh <fixture-name> "<prompt>"
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <fixture-name> \"<prompt>\"" >&2
  exit 2
fi

name="$1"
prompt="$2"
out="test/fixtures/stream-json/${name}.jsonl"

mkdir -p "$(dirname "$out")"
echo "Capturing to $out ..." >&2
cursor-agent --print --output-format stream-json --force "$prompt" > "$out" || true
echo "Captured $(wc -l <"$out" | tr -d ' ') lines to $out" >&2

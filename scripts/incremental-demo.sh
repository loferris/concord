#!/usr/bin/env bash
# Incremental mode demo: chapters arrive one at a time; the shared glossary grows one version per chapter.
# Usage: scripts/incremental-demo.sh [runId]   (a worker must be running)
set -euo pipefail
cd "$(dirname "$0")/.."
RUN_ID="${1:-inc-$(date +%Y%m%d-%H%M%S)}"
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
pgrep -f 'src/worker\.ts$' >/dev/null || { echo "✗ no worker running (bun run worker)" >&2; exit 1; }
for ch in 01 02 03; do
  say "Chapter $ch arrives → cli add-chapter $RUN_ID data/zh/$ch.txt"
  bunx tsx src/cli.ts add-chapter "$RUN_ID" "data/zh/$ch.txt" | grep -v '^\[llm\]'
done
say "Growth table"
bunx tsx src/cli.ts growth "$RUN_ID"
say "Glossary v3"
bunx tsx src/cli.ts glossary "$RUN_ID" 3 | sed -n '/== Glossary/,$p'
say "Eval (three columns + reference)"
bunx tsx src/cli.ts eval "$RUN_ID" "$RUN_ID" --ref --glossary-version 3 | grep -v '^\[llm\]'

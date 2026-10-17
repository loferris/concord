#!/usr/bin/env bash
# Durable-execution demo: start a translate run, kill -9 the worker mid-chapter, show Temporal's view of the
# run while nothing is running, restart the worker, and watch the run finish from where it stopped.
# Usage: scripts/kill-resume.sh <glossaryRunId> [chapter files...]
set -euo pipefail
cd "$(dirname "$0")/.."
GLOSSARY_RUN="${1:?usage: scripts/kill-resume.sh <glossaryRunId> [chapters...]}"; shift || true
CHAPTERS=("$@"); [ ${#CHAPTERS[@]} -eq 0 ] && CHAPTERS=(data/zh/01.txt data/zh/02.txt data/zh/03.txt)
WORKER_LOG=.tmp/worker-demo.log

say()   { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
note()  { printf '  \033[2m%s\033[0m\n' "$*"; }
pause() { local n=$1; shift; note "$* (${n}s)"; sleep "$n"; }

# ---- 0. Preconditions -------------------------------------------------------------------------
for pid in $(pgrep -f 'src/worker\.ts$' || true); do
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^FAKE_LLM=1$'; then
    echo "✗ A FAKE_LLM worker (pid $pid) is running. Stop it first; this demo uses real models." >&2; exit 1
  fi
done
if ! grep -q '^CRUSOE_API_KEY=' .env 2>/dev/null && [ -z "${CRUSOE_API_KEY:-}" ]; then
  echo "✗ CRUSOE_API_KEY not set (.env). Refusing to demo on the fake model." >&2; exit 1
fi
[ -f "run-data/$GLOSSARY_RUN/glossary/glossary.v2.json" ] || { echo "✗ no glossary.v2.json in run-data/$GLOSSARY_RUN" >&2; exit 1; }
if pgrep -f 'src/worker\.ts$' >/dev/null; then
  say "A worker is already running; stopping it so the demo owns the worker lifecycle"
  pkill -f 'src/worker\.ts$' || true; sleep 1
fi

start_worker() {
  : > "$WORKER_LOG"
  nohup bunx tsx src/worker.ts >> "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  disown "$WORKER_PID" 2>/dev/null || true
  for _ in $(seq 1 60); do grep -q 'listening on queues' "$WORKER_LOG" && break; sleep 1; done
  note "worker pid $WORKER_PID, backend: $(grep -o 'model backend: .*' "$WORKER_LOG" | head -1)"
}

# ---- 1. Start -------------------------------------------------------------------------------
say "1/6  Starting a worker"
start_worker

say "2/6  Starting a translate run against glossary $GLOSSARY_RUN (detached)"
OUT=$(bunx tsx src/cli.ts translate "$GLOSSARY_RUN" "${CHAPTERS[@]}" --detach)
echo "$OUT" | sed 's/^/  /'
RUN_ID=$(echo "$OUT" | grep -oE 'runId=[0-9a-z-]+' | head -1 | cut -d= -f2)
WF="translate-$RUN_ID"; CH1="chapter-$RUN_ID-01"

# ---- 2. Wait until chapter 1 has a model call in flight ------------------------------------
say "3/6  Waiting until chapter 1 has a model call in flight"
for _ in $(seq 1 120); do
  if temporal workflow describe -w "$CH1" -o json 2>/dev/null | scripts/temporal-state.py running-check; then break; fi
  sleep 1
done
temporal workflow describe -w "$CH1" -o json 2>/dev/null | scripts/temporal-state.py activities
pause 2 "letting the model call get going"

# ---- 3. Kill -9 ----------------------------------------------------------------------------
say "4/6  kill -9 the worker — the HTTP call to Crusoe dies with it"
# bunx wraps tsx wraps node: kill every process whose command line is the worker, not just the wrapper.
pkill -9 -f 'src/worker\.ts$' 2>/dev/null || true
kill -9 "$WORKER_PID" 2>/dev/null || true
sleep 1
if pgrep -f 'src/worker\.ts$' >/dev/null; then echo "  ✗ a worker process survived" >&2; exit 1; fi
note "no worker process is running (verified with pgrep)"

say "     Temporal's view while nothing is running:"
temporal workflow describe -w "$WF" -o json 2>/dev/null | scripts/temporal-state.py summary
temporal workflow describe -w "$CH1" -o json 2>/dev/null | scripts/temporal-state.py summary
note "the activity's heartbeat stops; after heartbeatTimeout (15s) Temporal will schedule attempt 2 — for whoever polls next"
pause 20 "waiting past the 15s heartbeat timeout with no worker"
temporal workflow describe -w "$CH1" -o json 2>/dev/null | scripts/temporal-state.py summary

# ---- 4. Restart and resume -----------------------------------------------------------------
say "5/6  Restarting the worker — it picks up the pending attempt; finished steps are not redone"
start_worker
pause 3 "worker polling"
temporal workflow describe -w "$CH1" -o json 2>/dev/null | scripts/temporal-state.py summary

say "6/6  Waiting for the run to complete, then the checks summary"
bunx tsx src/cli.ts wait "$RUN_ID" "$GLOSSARY_RUN"
say "Done. runId=$RUN_ID  (worker pid $WORKER_PID left running)"

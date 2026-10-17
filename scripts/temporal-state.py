#!/usr/bin/env python3
"""Print a compact view of a workflow from `temporal workflow describe -o json` (stdin).
Usage: temporal workflow describe -w <id> -o json | scripts/temporal-state.py [running-check|summary|activities]
Exit code for running-check: 0 if an activity is STARTED, 1 otherwise."""
import json, sys
mode = sys.argv[1] if len(sys.argv) > 1 else "summary"
raw = sys.stdin.read().strip()
if not raw:
    print("  (workflow not found yet)") if mode != "running-check" else None
    sys.exit(1)
d = json.loads(raw)
pa = d.get("pendingActivities") or []
if mode == "running-check":
    sys.exit(0 if any(a.get("state") == "PENDING_ACTIVITY_STATE_STARTED" for a in pa) else 1)
i = d["workflowExecutionInfo"]
if mode in ("summary",):
    print(f"  {i['execution']['workflowId']}: {i['status'].replace('WORKFLOW_EXECUTION_STATUS_', '')}, {i.get('historyLength')} history events")
    for c in d.get("pendingChildren") or []:
        print(f"    pending child: {c['workflowId']}")
for a in pa:
    lf = (a.get("lastFailure") or {}).get("message", "")
    hb = a.get("lastHeartbeatTime", "-")
    print(f"    pending activity: {a['activityType']['name']} attempt {a.get('attempt')}, state {a.get('state','').replace('PENDING_ACTIVITY_STATE_', '')}, last heartbeat {hb}" + (f", last failure: {lf[:100]}" if lf else ""))

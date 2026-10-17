# concord: agent team that agrees on a glossary, then translates a novel consistently

Built today (Oct 17, 2026, 10:45–5:00) at the Recursive Agents Hackathon. Problem statement: **Shared Brain**.
All code in this repo must be written today. Commit small and often with clear messages.

## Goal
Translate a Chinese novel (data/zh/*.txt, 3 chapters) into English with an agent team whose shared
memory (a glossary) stays current, efficient and conflict-free, and prove it with measured consistency gains.

## Stack (do not change without asking)
- TypeScript, Node 20+. Temporal TS SDK (@temporalio/*). OpenAI SDK pointed at Crusoe.
- Zod for every agent's output; send it as `response_format` via `zodResponseFormat`.
- Temporal dev server runs separately: `temporal server start-dev --db-filename .tmp/temporal.db`.

## Crusoe (read docs/crusoe-skill.md for details)
- Base URL: https://api.inference.crusoecloud.com/v1, key in env CRUSOE_API_KEY. Never print or commit it.
- Exact model IDs:
  - translator: `nvidia/Nemotron-3.5-Lightning-30B-A3B`
  - terminologist, reviewer, proposers: `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`
- Lightning thinks by default: pass `chat_template_kwargs: { enable_thinking: false }`; max_tokens ≥ 1024;
  treat finish_reason "length" or empty content as a retryable error.
- Rate limits are per model per minute. Concurrency is set per task queue, not ad hoc.
- OpenAI client: maxRetries 0 (Temporal owns retries). 429/5xx/timeouts/schema failures → retry.
  400/401/403/404 → `ApplicationFailure.nonRetryable`.
- Put stable content first in every prompt (brief + frozen glossary, sorted), chapter text last,
  for prefix caching. Log usage.prompt_tokens_details.cached_tokens.
- Use a fixed `seed` for eval runs.

## Architecture
- `src/workflows.ts`: deterministic only, no I/O, no OpenAI import.
  - `BookWorkflow`: extract → debate → freeze glossary → chapters in parallel → post-pass checks.
  - `DebateWorkflow` (child, one per contested term).
  - `ChapterWorkflow`: translate → term lint → review → revise (≤3) → approve or flag.
- `src/activities/`: every model call and every file read/write. All long activities heartbeat in the
  background; workflows set heartbeatTimeout 15s.
- **Text never goes into workflow history.** Activities write to `run-data/<runId>/...` atomically
  (tmp + rename) and pass paths.
- **Paragraph IDs:** split each chapter into paragraphs `p001…`; the translator returns
  `{id, text}` per paragraph; every check works per paragraph.
- Task queues: `workflows`, `fast` (translator), `smart` (Super roles).
- `src/checks.ts`: pure functions, unit-tested: term rendering distribution, banned variants,
  leftover CJK (regex), missed-term mining. Same functions power the post-pass and the eval.
- `src/fake.ts`: deterministic fake model used when CRUSOE_API_KEY is unset, so everything runs offline.

## Glossary design
- Candidates: boundary-entropy pass (pure code) + LLM extraction; merge nested terms (金丹/金丹期).
- Three blind proposers (fidelity / readability / genre conventions) render each term independently.
  Agreement → frozen. Disagreement → one critique round → terminologist decides and writes a rationale.
- Entries: source, rendering, aliases, banned variants, rationale. Book-wide policies (names, titles,
  honorifics) are decided first.
- Reviewer judges quality only; it never votes on terms.

## Data rules
- `ref/english-reference.md` is the answer key. **Never put it in any agent prompt.** Only `eval` reads it.

## Milestones (do them in order; stop and show me the output after each)
1. One chapter end to end through Temporal on Crusoe, paragraph IDs preserved. (target 12:00)
2. Extract + debate + frozen glossary written to run-data. (1:30)
3. All chapters in parallel against the glossary + checks report. (2:45)
4. `eval`: baseline (one prompt per chapter, no glossary) vs full system: term consistency, banned
   variants, leftover CJK, cost and cached-token rate. Plus a kill -9 / resume script. (3:45)

## Working style
- Small steps. Run it after every change and show me the real output; don't claim it works untested.
- Ask before adding a dependency or changing the architecture.
- Keep the README "Built today" section updated as features land.

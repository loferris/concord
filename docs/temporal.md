# How the Temporal side behaves: decision chains and collisions

Written Oct 17, 2026 against the code as of milestone 3. Facts about observed behaviour are marked *measured*.

## Topology

One worker process (`src/worker.ts`) hosts three Temporal Workers on three task queues:

| queue | what runs there | concurrency |
|---|---|---|
| `workflows` | workflow code only (`BookWorkflow`, `DebateWorkflow`, `ChapterWorkflow`, `TranslateBookWorkflow`), sandboxed and deterministic | default |
| `fast` | DeepSeek calls (translate, revise, baseline) and Lightning extraction | 2 |
| `smart` | Super decision calls, GLM review, and the file-only "local" activities | 2 |

The Temporal dev server keeps the history. The CLI starts a workflow and blocks on its result; it holds no state.
All text lives in `run-data/<runId>/…`; workflow history carries paths, counts, verdicts and glossary entries.

## Chains of decisions

Three layers decide things, and it helps to know which one made a given decision.

1. **Workflow code decides control flow** from small activity results. `DebateWorkflow` compares three
   proposals and chooses agreement vs critic→terminologist. `ChapterWorkflow` reads a verdict plus lint counts
   and chooses approve, revise, or flag. `BookWorkflow` sequences phases and, after v1, runs the nested-term
   re-decisions one at a time on purpose (see collisions, below).
2. **Activities decide retry vs fail** by the error type they throw. Schema failures, truncation, empty output,
   paragraph-id mismatches, rendering checks and 429/5xx are retryable; 400/401/403/404 and an empty chapter
   are not. Retry policies: `fast` 6 attempts, `smart` 8, backoff 2s→60s, a 429 waits 15s.
3. **The attempt counter decides the model.** `attemptSeed()` perturbs the seed per attempt so a retry is not a
   replay, and `modelForAttempt()` switches family after N attempts (tagger: DeepSeek→Super at 3; Super
   decision calls: Super→Lightning at 4). This is a chain across attempts: *why* an attempt failed is not
   visible to the next one, so a 429 storm advances the counter just like a model loop does, and can push a
   decision call onto the fallback model even though Super never misbehaved. *Measured:* 52 429s in one
   glossary run at 3 concurrent. The 15s 429 delay and concurrency 2 reduce this; the clean fix is to carry the
   last failure type in heartbeat details and only switch models after a loop or truncation.

The full chain for a book run is: tag (chapters in parallel) → extract (two sequential passes) → group →
policies → N `DebateWorkflow` children in parallel (3 proposals each in parallel, then critic, then
terminologist) → `writeGlossary` v1 → nested-term violations re-decided sequentially → v2 → `ChapterWorkflow`
for chapter 1 alone → chapters 2..n plus baselines in parallel → checks. Each `ChapterWorkflow` is translate →
(review → revise) up to 3 times.

## Collisions and races

- **Workflow ids.** Ids are deterministic from the runId: `book-<runId>`, `debate-<runId>-<source>`,
  `chapter-<runId>-<chapter>`, `translate-<runId>`. The runId carries a timestamp and random suffix, so two runs
  collide only if a runId is reused by hand (`cli start <file> <runId>`), in which case Temporal refuses the
  second start while the first is open. Entity sources are deduplicated in code, so two debates never share an id.
- **Two workers on the same queues.** Temporal hands tasks to whichever worker polls first. During development
  a fake-model worker and a real one were never run together, but nothing enforces it; if both were up, a real
  run would get fake answers for some activities with no error. Mitigation: suffix queue names with the backend
  (`fast-fake`) or refuse to start a real worker when `FAKE_LLM` workers are registered.
- **Rate limits are per model, queues are per worker.** *Measured:* Crusoe's `429 max_requests_limit
  (orchestrator)` is a per-model in-flight cap, not a per-minute rate (Lightning rejects a second concurrent
  request). Concurrency is set per queue per worker process, so two worker processes or two concurrent book runs
  double the in-flight requests and the retry storms. The `fast` queue also mixes DeepSeek and Lightning; within
  one run they never overlap, across two runs they can.
- **Parallel debates cannot see each other.** Each `DebateWorkflow` runs with the list of other sources but no
  other decisions, so two entities can freeze the same rendering. `writeGlossary` catches collisions in code and
  flags `needs_human`; the nested-term pass runs sequentially with the dependent rendering frozen as a constraint
  precisely to avoid this. *Measured:* one collision caught (师傅 banned "Shifu", 顾衡's alias rendering).
- **Zombie attempts and file writes.** If an attempt misses heartbeats (15s) or its start-to-close (10 min),
  Temporal schedules a retry while the first may still be running. Both write the same `run-data` path. Writes
  are atomic (tmp + rename), so no partial file is ever visible, but the file left on disk may belong to the
  attempt whose result Temporal ignored. Both also append to `usage.jsonl` (POSIX `O_APPEND` line writes are
  atomic), so cost is over-reported rather than under-reported. Putting the attempt number in file names would
  remove the ambiguity.
- **Determinism and code changes.** Workflow code does no I/O, no `Date`, no `Math.random` (the CLI makes the
  runId). Restarting a worker with changed workflow code while a run is in flight makes replay fail for that run;
  during the hackathon we terminated and re-ran instead of using `patched()`. Activity code can change freely.
- **File-only activities on the `smart` queue.** `listEntities`, `writeGlossary`, `runChecks` compete with model
  calls for the two `smart` slots. Harmless at this scale; a dedicated `io` queue would be cleaner.
- **History size.** A run produces roughly 25 child workflows and a few hundred events, far below Temporal's
  limits, because paragraph text never enters history.

## What this buys: kill -9 and resume

Every step's result is in history and every artefact is a file written atomically. Killing the worker mid-run and
restarting it resumes the run: finished activities are not redone, in-flight ones are retried from their attempt
counter (so a retry may use the fallback model, see above), and child workflows continue from their own
histories. A kill during a write leaves at most a stray `*.tmp` file. This is the milestone-4 demo.

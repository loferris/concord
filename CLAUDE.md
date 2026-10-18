# concord: agent team that agrees on a glossary, then translates a novel consistently

Built on Oct 17, 2026 at the Crusoe × Cerebral Valley Recursive Agents Hackathon (problem statement **Shared
Brain**) with Claude Code. The README is the public face (results, FAQ, how to run); this file is the working
contract for agents editing the code. Commit small and often with clear messages.

## Goal
Translate a Chinese novel (`data/zh/*.txt`, 3 chapters) into English with an agent team whose shared memory
(a versioned glossary) stays current, efficient and conflict-free, and prove it with measured gains over a
one-prompt baseline. Canonical runs and their outputs are committed under `results/`.

## Stack (do not change without asking)
- TypeScript, Node 20+. Temporal TS SDK (@temporalio/*). OpenAI SDK pointed at Crusoe. Zod on every agent
  output, sent as `response_format` via `zodResponseFormat`. Tests: vitest (`bun run test`), `bun run typecheck`.
- Temporal dev server runs separately: `bun run temporal`. Run the worker through tsx/Node (`bun run worker`);
  Temporal's worker needs Node native modules, never the Bun runtime.
- Never run a `FAKE_LLM=1` worker and a real worker at the same time: they share task queues and Temporal
  will hand real activities to the fake one.

## Models on Crusoe (reference: docs/crusoe-cv-recursive-agents-hackathon-skill.md; prompts: docs/prompts.md)
- Base URL https://api.inference.crusoecloud.com/v1, key in env `CRUSOE_API_KEY` (`.env`, single quotes).
  Never print or commit it. Unset → deterministic fake model (`src/fake.ts`), so everything runs offline.
- Division of labor (`src/config.ts#MODELS`; per-agent thinking table in docs/prompts.md):
  - **Nemotron decides**: grouper, policies, 3 proposers, critic, terminologist on
    `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`, thinking off; extraction on `nvidia/Nemotron-3.5-Lightning-30B-A3B`.
  - **DeepSeek writes**: tagger, translator, reviser, baseline on `deepseek-ai/DeepSeek-V4.1-Flash`, thinking
    off (`chat_template_kwargs: { thinking: false }`). Tagger fallback: Super from attempt 3.
  - **GLM checks**: reviewer on `zai-org/GLM-5.3-Flash`, thinking ON (off missed 2/3 planted defects).
  - Nemotron thinking switch is `enable_thinking`; `src/llm.ts#thinkingKwargs` picks the switch per family.
- Measured on Oct 17 (keep these in mind, see docs/temporal.md):
  - Nemotron Super with `json_schema` output sometimes loops on whitespace to the token cap; with thinking on
    it never terminated. Retries use a perturbed seed (`attemptSeed`); decision calls fall back to Lightning
    from attempt 4 (`modelForAttempt`); a single failed proposer does not fail a debate.
  - Crusoe `429 max_requests_limit (orchestrator)` is a per-model in-flight cap, not RPM. Queues run 2
    concurrent; Lightning calls are sequential with pass A persisted and a 20s pause; 429s wait 15s.
  - Prefix cache lands in 512-token blocks and is not visible for a few seconds: keep the shared prefix
    (brief + policies + full sorted glossary) byte-identical across chapters and translate chapter 1 alone first.
  - Lightning reports no cache fields (`cached_tokens: null`); DeepSeek reports `created_cache_tokens`.
- OpenAI client: `maxRetries 0` (Temporal owns retries). 429/5xx/timeouts/truncation/empty/bad JSON/schema
  failures → retryable; 400/401/403/404 → `ApplicationFailure.nonRetryable`. Fixed `seed` on first attempts.

## Architecture
- `src/workflows.ts` is deterministic: no I/O, no OpenAI import, no `Math.random`.
  - `BookWorkflow` (batch): tag chapters in parallel → extract (two passes, capture–recapture) → group →
    policies → one `DebateWorkflow` child per entity → glossary.v1 → nested-term re-decisions → glossary.v2 →
    `ChapterWorkflow` for chapter 1, then the rest in parallel, plus baselines → checks.
  - `DebateWorkflow`: three blind proposers (own seeds) → agreement (raw, or after article/quote/hyphen
    normalization) or critic → terminologist.
  - `ChapterWorkflow`: translate → code lint + GLM review → revise (≤3) → approved or flagged. Approval needs
    the verdict AND zero lint violations.
  - `TranslateBookWorkflow`: reuse a finished glossary run (`cli translate`, `--into` to write into a run).
  - `AddChapterWorkflow` (incremental): tag → extract this chapter → skip known sources/aliases → one grouper
    call per new item against existing entities → debate only new entities with the frozen glossary as
    precedent → glossary.v{N+1} + `changelog.json` → translate + review. Frozen renderings never change
    silently; only `cli resolve` (human) writes a new version, with `resolved_from`.
- `src/activities/`: every model call and every file read/write. Long activities heartbeat every 5s
  (`withHeartbeat`); workflows set heartbeatTimeout 15s. Every call appends to `run-data/<run>/usage.jsonl`.
- **Text never enters workflow history.** Activities write `run-data/<runId>/...` atomically (tmp + rename,
  sanitized path segments) and return paths and counts.
- **Paragraph IDs** `p001…` round-trip through the translator; tagger output must reproduce the source
  exactly (`src/align.ts` snaps dropped quotes; altered text fails the attempt).
- Task queues: `workflows`; `fast` (DeepSeek + Lightning); `smart` (Super, GLM, file-only activities).
- Pure, unit-tested code around every model output: `src/extract.ts` (boundary-entropy candidates,
  `verifyExtraction`, time/number filter), `src/align.ts`, `src/normalize.ts`, `src/checks.ts` (term
  distribution with longest-first masking, chapter-scoped banned variants, ambiguous-variant exclusion,
  paragraph coverage, leftover CJK, collisions, nested terms, cross-chapter drift, per-paragraph lint).
- Eval-only code: `src/eval.ts`, `src/report.ts`. `ref/english-reference.md` is the answer key: never in any
  prompt; `test/no-ref-leak.test.ts` enforces that nothing under prompts/activities/workflows mentions it.
- CLI (`src/cli.ts`): `start`, `book [--stop-after group|glossary]`, `translate`, `wait`, `add-chapter`,
  `growth`, `structure`, `glossary`, `resolve`, `eval [--ref] [--hits] [--glossary-version N]`, `report`.
  Demos: `scripts/kill-resume.sh`, `scripts/incremental-demo.sh`.

## Glossary design
- Candidates: boundary-entropy pass (pure code) + LLM extraction, verified verbatim against the text.
- Three blind proposers (fidelity / readability / genre) → agreement freezes; otherwise critique → terminologist
  with a rationale. Entries: source, type, rendering, aliases, alias renderings, banned variants, context
  rules, decided_by (agreement | terminologist | human), rationale, needs_human, code_notes.
- Code guards on the glossary itself: no CJK, markdown or diacritics in renderings; banned never contains the
  chosen rendering; two sources never share a rendering (flagged needs_human); nested-term rule (A ⊃ B ⇒
  A's rendering contains B's), re-decided under constraint.
- Book-wide policies first. Reviewer judges quality only and may dispute a term (goes to a human, not the
  translator).

## Working style
- Small steps. Run it after every change and show the real output; never claim it works untested.
- Ask before adding a dependency or changing the architecture or the prompts (prompts are verbatim from
  docs/prompts.md).
- When eval logic changes, regenerate `results/*/eval.txt` and `report.html` and update the README tables.
- Keep README numbers tied to the committed runs in `results/`.

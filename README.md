# concord

An agent team that first agrees on a glossary (its shared brain), then translates a Chinese novel into
English consistently. Temporal orchestrates the agents; models run on Crusoe Managed Inference.

## Run

```bash
bun install
cp .env.example .env            # put CRUSOE_API_KEY in .env (single quotes). Unset -> deterministic fake model.
# data/zh/01..03.txt is the source; ref/english-reference.md is the answer key and is read only by `eval`.
bun run temporal                # Temporal dev server (separate terminal)
bun run worker                  # one process, three task queues: workflows, fast, smart
bun run cli start data/zh/01.txt
```

Output lands in `run-data/<runId>/chapters/<chapter>/translation.json` (`{paragraphs:[{id,text}]}`) plus a
readable `translation.en.txt` and `translate.usage.json`. Workflow history only carries paths and token counts.

`FAKE_LLM=1` forces the offline fake model even when a key is set.

## Built today (Oct 17, 2026)

- [x] **Milestone 1**: one chapter end to end through Temporal on Crusoe, paragraph IDs preserved.
  - `src/llm.ts`: OpenAI SDK against Crusoe, `maxRetries 0`, Zod `response_format`, thinking off for the
    translator, `max_tokens >= 1024`, `finish_reason=length`/empty content/bad JSON/schema → retryable;
    400/401/403/404 → non-retryable. Logs `cached_tokens` per call.
  - `src/fake.ts`: deterministic fake used when `CRUSOE_API_KEY` is unset.
  - `src/text.ts`: paragraph splitter (`p001…`); `translateChapter` activity verifies the ID set round-trips.
  - `ChapterWorkflow` = translate only (lint/review/revise come in milestone 3). Heartbeats every 5s,
    `heartbeatTimeout 15s`, retries up to 6 attempts.
  - Real run on `data/zh/01.txt` (The Grey List, ch. 1): 18/18 paragraph IDs round-tripped, zero leftover
    CJK, 887 prompt / ~930 completion tokens. Without a glossary the translator already drifts
    (沈澈 → "Shen Jie", 沈哥 → "Shen Ge"), which is the problem milestone 2 fixes.
  - Caching note: Crusoe returns `prompt_tokens_details: null` for Lightning and `cached_tokens: 0` for
    Super on identical ~700-token prompts repeated back to back. We record `null` as "not reported" rather
    than 0% and keep logging it per call.
  - Translator switched to **DeepSeek V4.1 Flash** (`deepseek-ai/DeepSeek-V4.1-Flash`, thinking off); Nemotron
    Super stays on coordination/extraction. Chapter 1: 18/18 ids, 612 prompt / ~900 completion tokens,
    `reasoning_tokens` 0. Cache: first calls report `created_cache_tokens: 512`; a repeat ~20s later
    reported `cached_tokens: 512` (83.7%). Cache lands in 512-token segments and is not instant.
- [x] **Milestone 2a**: structure and terms. `bun run cli book data/zh/*.txt --stop-after group`, then
  `cli structure <runId>` prints the address-form table, entities with aliases, and what was kept separate.
  - Tagger (Super, thinking off) splits each paragraph into narration/speech/thought/text_message segments
    with speaker, addressee and form of address. Code verifies the joined segments equal the source
    exactly; dropped or flipped quotation marks at segment edges are snapped back (`src/align.ts`, tested),
    any altered character fails the attempt as retryable with paragraph id and char index.
  - `src/extract.ts`: boundary-entropy candidates (2–4 char substrings, ≥3 occurrences across ≥2
    paragraphs, scored by branching entropy × cohesion, nested terms merged) + `verifyExtraction`, which
    drops LLM items that are not verbatim in the text or occur only once (names excepted). Unit-tested.
  - Extractor: Lightning, whole book in one call. Alias grouper: Super, with the tagger's address-form table
    as evidence and a code-side reconciliation (a form seen as "X → Y: form" belongs to Y).
  - Real run on 01–03: 20 entities; 小鹿 grouped under 陆楠, 沈哥/阿澈 under 沈澈, 师父 under 顾衡,
    师父/师傅 kept separate. Address table: 陆楠→沈澈: 沈哥 ×3, 沈澈→陆楠: 小鹿 ×2, 顾衡→沈澈: 阿澈 ×2,
    沈澈→顾衡: 师父, 沈澈→司机: 师傅.
  - **Resilience, measured:** Nemotron Super's guided JSON decoding sometimes degenerates into an
    endless-whitespace loop (hit the 8,192-token cap at ~1 min/attempt; temperature and repetition
    penalty did not help). Retries use a perturbed seed, and from the 3rd attempt the tagger/grouper fall
    back to DeepSeek V4.1 Flash (`modelForAttempt`). One chapter in the real run took that path.
- [x] **Milestone 2b**: decide and freeze. `bun run cli book data/zh/*.txt` runs tag → extract → group →
  policies → one `DebateWorkflow` child per entity → `glossary.v1.json`; `cli glossary <runId>` prints it.
  - Policies (Super) run once before any term. Three blind proposers (fidelity / readability / genre, each with
    its own seed) run in parallel; identical renderings freeze as `decided_by: agreement` (raw, or after
    normalizing articles, quotes and hyphen/space; grey vs gray stays a disagreement). Otherwise critic →
    terminologist, `decided_by: terminologist` with a rationale.
  - **Code checks around every model call** (the hardening pass): grouper sources must be extracted items
    and belong to one entity, unplaced items become singletons; proposer/terminologist renderings must be
    non-empty and CJK-free, banned never contains the chosen rendering, alias renderings are filled, the
    terminologist's `source` is corrected, empty context rules dropped; the glossary writer flags CJK and
    rendering collisions and removes banned variants that are another entry's rendering. Every fix is
    recorded in the entry's `code_notes`.
  - Resilience: perturbed seed per retry everywhere; Super decision calls fall back to Lightning from the
    4th attempt; 429s wait 15s. Every model call appends to `run-data/<run>/usage.jsonl`.
  - **Glossary fix pass:** time/number expressions are filtered out of extraction (`isTimeOrNumber`);
    renderings with markdown or diacritics are rejected as retryable; the **nested-term rule** (if A's
    source contains B's source, A's rendering must contain B's) re-decides only the violators with B's
    rendering as a frozen constraint and writes `glossary.v2.json`; extraction runs twice and the overlap
    gives a capture–recapture (Chapman) estimate of term recall, recorded in `extraction.json`.
- [x] **Milestone 3**: translation against the glossary + ablation.
  - `cli book <chapters>` continues past the glossary: chapter 1 alone (warms the shared prefix), then the
    rest in parallel, then the one-prompt baseline (prompt #11, same DeepSeek model, no glossary, no ids).
    `cli translate <glossaryRunId> <chapters>` reuses a finished glossary run.
  - `src/checks.ts` (pure, tested): term rendering distribution with longest-first variant masking, banned
    variants, per-paragraph term coverage, leftover CJK, rendering collisions, nested-term violations.
  - `cli eval <runId> [glossaryRunId]` prints the ablation table: baseline vs full system, with cost and
    cached-token rate computed from `usage.jsonl` and the Crusoe price list in `src/config.ts`.
- [ ] Milestone 3b: reviewer (GLM-5.3-Flash) → revise loop.
- [ ] Milestone 4: kill -9 / resume script; eval against `ref/english-reference.md`.
- [ ] Milestone 3: all chapters in parallel + checks report.
- [ ] Milestone 4: eval (baseline vs full system), kill -9 / resume script.

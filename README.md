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
- [ ] Milestone 2b: policies + debates + frozen glossary.v1.json (code written, not yet run).
- [ ] Milestone 3: all chapters in parallel + checks report.
- [ ] Milestone 4: eval (baseline vs full system), kill -9 / resume script.

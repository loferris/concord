# concord

An agent team that first agrees on a glossary (its shared brain), then translates a Chinese novel into
English consistently. Temporal orchestrates the agents; models run on Crusoe Managed Inference.
Built in one day at the Crusoe × Cerebral Valley Recursive Agents Hackathon (Oct 17, 2026), problem statement
**Shared Brain**.

**Nemotron decides. DeepSeek writes. GLM checks.** Every glossary decision (grouping, policies, three blind
proposals, critique, final ruling) is made by Nemotron; DeepSeek handles the Chinese text (tagging, translation);
GLM, a third model family, reviews so the writer never grades itself. Code verifies every model output and
Temporal makes the whole run durable: kill the worker mid-call and it resumes.

| role | model | thinking |
|---|---|---|
| tagger (structure the source), translator, baseline | `deepseek-ai/DeepSeek-V4.1-Flash` | off |
| extractor (whole book, 1M ctx) | `nvidia/Nemotron-3.5-Lightning-30B-A3B` | off |
| alias grouper, policies, 3 proposers, critic, terminologist | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | off |
| reviewer | `zai-org/GLM-5.3-Flash` | on |

## Headline result

Same DeepSeek writer in every column; glossary of 13 terms; 3 chapters (`results/batch-20261017-213120-j30v/`):

| | one-prompt baseline | full system, before review | full system, after review |
|---|---|---|---|
| term consistency (chosen vs known banned variants) | 78.4% | 99.2% | 99.2% |
| banned-variant hits | 25 across 6 terms | 1 | 1 |
| paragraph term coverage | n/a | 109/109 | 109/109 |
| total cost | $0.0023 | $0.058 | $0.083 |

Incremental mode (chapters arrive one at a time, the glossary grows v1 → v2 → v3, `results/incremental-inc-demo-3/`):
10 → 14 → 19 entities; 阿澈 attached as an alias of 沈澈 in v3; 师傅 kept separate from 师父. Details and caveats
under *Built today* below; `results/*/report.html` are the self-contained reports.

## Run

```bash
bun install
cp .env.example .env            # CRUSOE_API_KEY in single quotes. Unset -> deterministic fake model (offline).
bun run temporal                # Temporal dev server (separate terminal)
bun run worker                  # one process, three task queues: workflows, fast, smart (run via tsx/Node)
bun run test && bun run typecheck
```

Reproduce the demos (each prints its own tables; outputs land in `run-data/<runId>/`):

```bash
bun run cli book data/zh/01.txt data/zh/02.txt data/zh/03.txt   # batch: glossary v1/v2 + translate + review + ablation
bun run cli resolve <runId> 复核组 "Review Team"                   # a human answers a needs_human flag -> glossary.v3.json
bun run cli translate <glossaryRunId> data/zh/*.txt               # translate+review against the latest glossary version
bun run cli eval <runId> <glossaryRunId> --ref                    # 3-column ablation + reference eval
bun run cli report <runId> <glossaryRunId>                        # run-data/<runId>/report.html
bun run demo:kill-resume <glossaryRunId>                          # durability: kill -9 mid-call, resume
bun run demo:incremental                                          # ch1 -> v1, ch2 -> v2, ch3 -> v3, growth table
```

`FAKE_LLM=1` forces the offline fake model even when a key is set. `ref/english-reference.md` is the answer key
and is read by the eval only (a test enforces it). See `docs/prompts.md` for every agent prompt and
`docs/temporal.md` for how the workflows, retries, fallbacks and queues interact.

## Repository map

- `src/workflows.ts` deterministic Temporal workflows: `BookWorkflow`, `DebateWorkflow`, `ChapterWorkflow`,
  `TranslateBookWorkflow`, `AddChapterWorkflow` · `src/activities/` every model call and file write ·
  `src/llm.ts` Crusoe client with error classification · `src/prompts.ts` prompts verbatim from `docs/prompts.md` ·
  `src/schemas.ts` Zod output schemas · `src/extract.ts`, `src/align.ts`, `src/checks.ts`, `src/normalize.ts` pure,
  unit-tested code checks · `src/eval.ts` + `src/report.ts` eval-only · `src/fake.ts` offline model ·
  `scripts/` demos and benches · `results/` committed outputs of the demo runs · `data/zh/` source chapters.

## Open items

- `inc-demo-3` glossary v3 has one `needs_human` entry: 师傅 was proposed as "Shi Fu", colliding with the frozen
  师父. `cli resolve inc-demo-3 师傅 driver` would clear it (the reference agrees with "driver").
- The attempt-counter model fallback cannot tell a 429 storm from a model loop; carrying the last failure type in
  heartbeat details would fix it (`docs/temporal.md`).
- Reviews cost ~9k reasoning tokens each; `reasoning_effort: low` on GLM is untested.
- Capture–recapture recall came out degenerate (second extraction pass ⊂ first) on the batch run.
- Per-item grouper calls in incremental mode grow with glossary size.

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
  - **Canonical run `20261017-213120-j30v`** (3 chapters, glossary **v3** from run `20261017-205002-c4sg`,
    13 terms, same DeepSeek writer in every column):

    | metric | baseline (1 prompt) | full, before review | full, after review |
    |---|---|---|---|
    | term consistency (chosen / chosen+banned) | 78.4% | 99.2% | 99.2% |
    | banned-variant hits (terms affected) | 25 (6) | 1 (1) | 1 (1) |
    | paragraph term coverage | n/a | 109/109 | 109/109 |
    | leftover CJK | 0 | 0 | 0 |
    | translation cost | $0.0023 | $0.0050 | + $0.0248 review/revise |
    | cached-token rate on translation | 87.6%* | 39.9% | 60.5% |
    | total cost | $0.0023 | $0.058 | $0.083 |

    Baseline drift: 夜航 "Night Voyage"×10 vs glossary "Ye Hang", 灰名单 "gray list"×6, 师傅 "master"/"mentor"×4,
    沈澈 → bare "Shen"×3. The one remaining full-system hit is "mentor" used for 师父 in narration, which the
    proposers had banned for the homophone 师傅; "mentor" is not any entry's rendering (师父 → "Shifu"), so the
    ambiguity exclusion does not apply and it stays counted: a limitation of the banned-variant metric, not a
    term error.
    \* The baseline prompt is byte-identical across runs, so it hits the cache built by earlier runs.

    **How to read the columns.** Term consistency counts the chosen rendering against *known banned variants*
    only. A banned variant that is also another entry's rendering or alias rendering (e.g. 浦东机场 banning
    "Lujiazui", which is 陆家嘴's rendering) is ambiguous at text level and is excluded from the count; the eval
    lists every excluded variant. After this exclusion the numbers above did not change. The after-review column is enforced by the loop (approval requires zero lint violations), so the
    before-review column and the baseline drift are the independent evidence. Chapter 1 of this run ended
    "flagged" because the lint demanded the exact word "review" where the text says "manually reviewed"; the
    checker now accepts inflections of lowercase single-word terms, and the table above is the recomputed eval.

  - **Reference eval** (`cli eval <run> --ref`; `ref/english-reference.md` is read by `src/eval.ts` only, and a
    test asserts no prompt, activity or workflow module mentions it):
    - Glossary agreement with the reference table (normalized rendering equals any "/" alternate): v1 10/16,
      v2 10/16, **v3 11/16**. v3 includes three human resolutions (复核 review, 复核组 Review Team, 观澜
      Guanlan with "Guanlan Data" unbanned) made by the reference's author, so v2 is the unaided score.
      Remaining mismatches: 沈哥 "Brother Shen" vs "Shen/boss", 阿澈 "Ah Che" vs "Che", 小鹿 "Xiao Lu" vs
      "Lu/kid", 夜航 "Ye Hang" vs "Night Flight", 灰名单 "graylist" vs "grey list". Six reference terms were not
      extracted (黑名单, 人工先验, 风控负责人, 陆家嘴, 浦东机场, the refrain), four of them because they occur once
      and the code filter drops single-occurrence terms.
    - Fact ledger (regex counts; total = occurrences in the reference): 3,412 accounts 3/3, 1–2 a.m. 2/2,
      72 hours 1/1, 200 million 1/1, nine years 1/1, three years 4/4, two months 1/1, ~300 1/1, 8 a.m. 3/3,
      for both baseline and full system (9/9 facts); "11 p.m." is not stated in the reference.
- [x] **Incremental mode** (`cli add-chapter <runId> <chapter>`, `scripts/incremental-demo.sh`): chapters arrive
  one at a time, as a serialized novel is published, and the shared glossary grows one version per chapter.
  When chapter N arrives: tag it; extract terms from it alone; exact-match against existing sources and
  aliases and skip what is known; for each new item one grouper call that sees the existing entities
  ("alias of X" or "new entity"; the address-form table can veto a merge, since a wrong merge is worse than a
  miss); debate only the new entities, with the frozen glossary and its rationales given to the proposers,
  critic and terminologist as precedent; frozen renderings never change (only `cli resolve` can); write
  `glossary.v{N+1}.json` and a `changelog.json` entry (chapter, new entities, new aliases, debates, precedents
  cited, calls, cost); translate + review that chapter against the new version. `cli growth <runId>` prints
  the growth table. Unlike batch debates, which run in parallel and cannot see each other, incremental
  debates always see the frozen glossary, so new terms cannot collide with old ones.
  - **Demo run `inc-demo-3`** (3:28 PM): ch1 → v1, ch2 → v2, ch3 → v3.

    | version | chapter | entities | new | aliases | debates | calls | cost | precedents cited |
    |---|---|---|---|---|---|---|---|---|
    | v1 | 01 | 10 | 10 | 0 | 0 | 35 | $0.028 | — |
    | v2 | 02 | 14 | 4 | 0 | 1 | 22 | $0.021 | 沈澈, 周总, 夜航 |
    | v3 | 03 | 19 | 5 | 1 (阿澈→沈澈) | 1 | 27 | $0.029 | 沈澈, 师父, 夜航, 陆家嘴, 白名单, 陆楠 |

    In v3, **阿澈 is attached as an alias of 沈澈** (rendered "A Che") and **师傅 is a separate entity from 师父**.
    Both were rendered "Shi Fu" by their proposers, so the frozen-glossary collision rule flagged 师傅
    `needs_human` rather than letting a new term collide with an old one. Chapter 2 cost less than chapter 1
    (22 vs 35 calls); chapter 3 did not (27 calls, $0.029): one grouper call per new item that includes every
    existing entity, five genuinely new terms (a new character's title, two places, new jargon), one alias
    decision, and 429 retries whose tokens are still billed. Eval against v3: 99.2% term consistency vs 80.2%
    baseline, coverage 114/115, total $0.11 (glossary $0.078) vs $0.083 for the whole-book run; reference
    glossary agreement 10/19 (the single-chapter extractor keeps single-occurrence fixed terms, so 19 terms
    vs 13 in batch, including 黑名单, 陆家嘴, 浦东机场, 人工先验).
- [x] **Milestone 4a: kill -9 / resume.** `scripts/kill-resume.sh <glossaryRunId>` (live demo): starts a run,
  kills every worker process mid-model-call, shows Temporal marking the activity "Heartbeat timeout" and
  scheduling attempt 2 with no worker alive, restarts the worker, and the run completes from there.
- [x] **Human resolutions.** `cli resolve <runId> <source> <rendering> [--unban v] [--same-version]` writes
  the next glossary version with `decided_by: human` and a `resolved_from` note citing the `needs_human` flag
  or the reviewer dispute it answers, then re-runs the nested-term and collision checks.
- [x] **Milestone 3b: reviewer loop.** `ChapterWorkflow` = translate → code lint + GLM review (thinking on)
  → revise (≤3) → approved or flagged. Approval needs the reviewer's verdict *and* zero lint violations.
  Real run: ch1 approved after 2 rounds (2 major + 7 minor → 0 major), ch2 after 2, ch3 after 1. The reviewer
  also raised a legitimate term dispute: the glossary bans "Guanlan Data" even where the source says 观澜数据.
  Reviews cost ~9k reasoning tokens each; `reasoning_effort: low` is the next thing to test.
- [ ] Milestone 4: kill -9 / resume script; eval against `ref/english-reference.md`.
- [ ] Milestone 3: all chapters in parallel + checks report.
- [ ] Milestone 4: eval (baseline vs full system), kill -9 / resume script.

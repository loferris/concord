# concord

An agent team that first agrees on a glossary (its shared brain), then translates a Chinese novel into
English consistently. Temporal orchestrates the agents; models run on Crusoe Managed Inference.
Built in one day at the Crusoe × Cerebral Valley Recursive Agents Hackathon (Oct 17, 2026), problem statement
**Shared Brain**. All code in this repository was written on Oct 17, 2026 with coding agents (Claude Code); the
first commit is 11:00 PDT.

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

Canonical run: **incremental mode, `inc-demo-3`**, glossary v4 (19 terms; chapters arrived one at a time, the
glossary grew v1 → v2 → v3, then one human resolution → v4). Same DeepSeek writer in every column; 3 chapters.
Files: `results/incremental-inc-demo-3/` (`report.html`, `eval.txt`, glossaries, translations).

| | one-prompt baseline | full system, before review | full system, after review |
|---|---|---|---|
| glossary adherence (chosen vs known banned variants) | 82.0% | 100% | 100% |
| banned-variant hits | 20 across 5 terms | 0 | 0 |
| cross-chapter drift (terms rendered differently across chapters) | 0 by known variants; 1 with the reference's alternates (师父: mentor in ch. 2, Master/Shifu in ch. 3) | 0 | 0 by known variants |
| paragraph term coverage | n/a | 114/115 | 115/115 |
| leftover Chinese | 0 | 0 | 0 |
| facts ledger (vs reference) | 9/9 | — | 9/9 |
| total cost | $0.0033 | $0.086 | $0.125 |

Growth: 10 → 14 → 19 entities over three chapters; 阿澈 attached as an alias of 沈澈 in v3; 师傅 kept separate from
师父 (flagged by the collision rule, resolved by a human to "driver" → v4; chapter 3 re-translated and approved).

Whole-book (batch) run for comparison, `results/batch-20261017-213120-j30v/`, glossary v3 of 13 terms: baseline
80.5% adherence with 22 banned hits and 3 drifting terms (白名单 whitelist/white list, 复核 review/check, 沈澈
Shen Che/bare Shen); full system 100%, 0 hits, 0 drift, 109/109 coverage; $0.0023 vs $0.083.

Glossary adherence measures agreement with the decided glossary, so the baseline loses points for consistent but
different choices such as "Night Voyage". Cross-chapter drift is the number of terms whose rendering changes
between chapters. Three chapters is too short for heavy drift; that is what the book-scale design is for.
Banned-variant counting is chapter-scoped and text-level, so a few baseline hits may still be misattributed;
`cli eval --hits` lists every hit with its sentence and flags suspects.

**Judges without a Crusoe key:** everything above is reproducible from the committed `results/` folder (open
`results/*/report.html`; `eval.txt` has the full tables), and the whole pipeline runs offline against a
deterministic fake model when `CRUSOE_API_KEY` is unset (`FAKE_LLM=1` forces it).

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

- The attempt-counter model fallback cannot tell a 429 storm from a model loop; carrying the last failure type in
  heartbeat details would fix it (`docs/temporal.md`).
- Reviews cost ~9k reasoning tokens each; `reasoning_effort: low` on GLM is untested.
- Capture–recapture recall came out degenerate (second extraction pass ⊂ first) on the batch run.
- Per-item grouper calls in incremental mode grow with glossary size.

## Credits

- Written with [Claude Code](https://claude.com/claude-code) as the coding agent, on the day of the hackathon, using both Opus 5.5 and Fable 5.1.
- Models on [Crusoe Managed Inference](https://www.crusoe.ai/): NVIDIA Nemotron 3 Super and 3.5 Lightning
  (glossary decisions, extraction), DeepSeek V4.1 Flash (tagging, translation), Z.ai GLM-5.3-Flash (review).
- Orchestration: [Temporal](https://temporal.io/) (TypeScript SDK, dev server).
- Demo video voice: ElevenLabs.
- fableforge, a different project of mine, was inspiration only; no code was reused.
- Source text: *The Grey List* (灰名单), original demo text written for this hackathon (see `data/README.txt`).

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
    | glossary adherence (chosen / chosen+banned) | 80.5% | 100% | 100% |
    | banned-variant hits (terms affected) | 22 (6) | 0 | 0 |
    | cross-chapter drift (terms) | 3 | 0 | 0 |
    | paragraph term coverage | n/a | 109/109 | 109/109 |
    | leftover CJK | 0 | 0 | 0 |
    | translation cost | $0.0023 | $0.0050 | + $0.0248 review/revise |
    | cached-token rate on translation | 87.6%* | 39.9% | 60.5% |
    | total cost | $0.0023 | $0.058 | $0.083 |

    Baseline drift: 夜航 "Night Voyage"×10 vs glossary "Ye Hang", 灰名单 "gray list"×6, 沈澈 → bare "Shen"×3,
    白名单 "white list", 复核 "check". Two of the 22 baseline hits are flagged suspect by `--hits` ("master" in
    the chapter-3 title is 师父's paragraph; "I checked" is the verb). Before chapter scoping the full system
    showed one hit, "mentor" in chapter 2 where 师傅 never occurs; scoping removed it.
    \* The baseline prompt is byte-identical across runs, so it hits the cache built by earlier runs.

    **How to read the columns.** Glossary adherence counts the chosen rendering against *known banned
    variants* only: it measures agreement with the decided glossary, so the baseline loses points for
    consistent but different choices such as "Night Voyage". Three chapters is too short for heavy drift;
    that is what the book-scale design is for. A banned variant that is also another entry's rendering or alias rendering (e.g. 浦东机场 banning
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
    `needs_human` rather than letting a new term collide with an old one. The human resolved 师傅 → "driver"
    (`cli resolve inc-demo-3 师傅 driver` → v4) and chapter 3 was re-translated against v4 and approved after
    two review rounds. Chapter 2 cost less than chapter 1
    (22 vs 35 calls); chapter 3 did not (27 calls, $0.029): one grouper call per new item that includes every
    existing entity, five genuinely new terms (a new character's title, two places, new jargon), one alias
    decision, and 429 retries whose tokens are still billed. Eval against v4 (chapter-scoped banned counting):
    100% glossary adherence vs 82.0% baseline, cross-chapter drift 0 vs 0 by known variants (the baseline's real
    师父 drift, "mentor" in ch. 2 vs "Master"/"Shifu" in ch. 3, is invisible to the text-level metric because
    "mentor" is not a known variant; with the reference's alternates added as forms the baseline shows 1 and the
    full system also 1, since its ch. 2 says both "Shi Fu" and "mentor" while ch. 3 says only "Shi Fu"),
    coverage 115/115, total $0.125 including the chapter-3
    re-translation (glossary $0.078) vs $0.083 for the whole-book run; reference glossary agreement 10/19 (the
    single-chapter extractor keeps single-occurrence fixed terms, so 19 terms vs 13 in batch, including 黑名单,
    陆家嘴, 浦东机场, 人工先验). Note that 8 of the 20 baseline hits are "Director Zhou", which this run's agents
    froze as "Zhou Zong" and banned; the batch run's agents chose the opposite, so that part of the baseline's
    penalty is a debatable agent decision rather than drift.
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

## FAQ

<details>
<summary><b>Isn't this just an auto-glossary? Several tools build those.</b></summary>

They do: novel-translation tools extract names and terms automatically, and DeepL can generate glossaries from past translations. Those are one model's pass over the text. Concord decides each term by debate with a written rationale, attaches nicknames to the right character, keeps same-sound words like 师傅 (driver) and 师父 (mentor) apart, escalates hard cases to a human, versions every decision, and measures whether each chapter followed the glossary. Our baseline is one prompt per chapter with no glossary, so part of the gain is simply having one; comparing against an auto-glossary tool is the next evaluation.

</details>

<details>
<summary><b>Why web novels?</b></summary>

Serialization turns translation into an online problem. Chapters arrive one at a time for years, so each term is decided before the story explains it, must hold for thousands of chapters, and sometimes has to be reopened. That requires versioned decisions, knowing which chapters a changed term touched, and orchestration that survives months of runtime. The glossary is the only memory that spans a book far longer than any context window.

</details>

<details>
<summary><b>Who else needs this?</b></summary>

Anywhere many writers must use the same words for a long time and a changed word is expensive: live-service game localization, patents, drug labeling and clinical documents, contract families, subtitles across seasons. The same loop works within one language: writers' rooms, coding-agent teams sharing a codebase's vocabulary, enterprise metric definitions.

</details>

<details>
<summary><b>Why Chinese?</b></summary>

It's a standard benchmark language for document-level translation, has no word boundaries (terms must be discovered), and is dense with aliases, address forms and same-sound characters.

</details>

<details>
<summary><b>Synthetic data?</b></summary>

The Grey List is three chapters written for this test, with planted traps (师傅/师父, a nickname, a refrain, a fact ledger) and a reference translation that only the evaluation reads. No rights issues.

</details>

<details>
<summary><b>What does "100% glossary adherence" mean? Isn't that graded by your own checks?</b></summary>

It measures whether the translation used the decided rendering for each term occurrence. Counting is text-level and chapter-scoped, and every counted hit can be printed with its line (`cli eval --hits`). The full system reaches 100% before the review loop runs, so the glossary does the work, not the reviewer. The baseline's 82% partly reflects consistent but different choices (for example, 11 of its 20 hits are "Director Zhou", which the agents banned in favor of "Zhou Zong"). Independent checks: agreement with a reference glossary, and a fact ledger that is 9 of 9 for both baseline and full system.

</details>

<details>
<summary><b>Does the full system ever drift?</b></summary>

By known variants, no: zero banned variants, and the chosen rendering appears in every chapter. Against the reference's alternates, chapter 2 uses "mentor" alongside "Shi Fu" for 师父, so a strict drift count gives 1. The baseline gives that same person three titles ("mentor", "Master", "Shifu"). Measuring variants nobody predicted needs span alignment between source and translation, which is planned.

</details>

<details>
<summary><b>What if the glossary is wrong?</b></summary>

Agreement isn't correctness: in one run all three proposers agreed on a wrong time. So code checks the glossary itself (collisions, nested terms, no Chinese characters or markup in renderings), the terminologist can mark an entry needs-human, the reviewer can dispute a term, and a human resolution (`cli resolve`) writes a new version that records what it answered. In the incremental run, the proposers gave 师傅 the mentor's rendering; code refused to freeze it, and a human resolved it to "driver" in v4.

</details>

<details>
<summary><b>Did later chapters cost less?</b></summary>

Chapter 2 did (22 model calls against 35 for chapter 1). Chapter 3 didn't (27 calls): it introduced the most new material, alias grouping cost grows with glossary size, and rate-limit retries bill tokens. Batching the grouper calls is the fix.

</details>

<details>
<summary><b>Does it scale to a 500-chapter novel?</b></summary>

Not unchanged. Whole-book extraction in one call works for three chapters but hits output limits and then context limits at book scale. Incremental mode is the start of the answer; next are windowed extraction, a termbase instead of JSON files, a cached core glossary plus per-chapter terms in the prompt, and re-translating only the chapters a changed term touches. Temporal already handles the fan-out.

</details>

<details>
<summary><b>Why Temporal?</b></summary>

Durability. Kill the worker mid-run and nothing finished is redone; every step is in the workflow history (`scripts/kill-resume.sh`). docs/temporal.md covers the failure modes measured today, such as rate-limit storms pushing retries onto a fallback model.

</details>

<details>
<summary><b>Why Crusoe?</b></summary>

Every call carries the same long glossary prefix, so prefix caching and cheap cached input matter, and one serving stack per model keeps the evaluation consistent. The API is OpenAI-compatible, so switching providers is a configuration change.

</details>

<details>
<summary><b>Why three model families?</b></summary>

The writer never grades itself, and the reviewer reads Chinese natively. Nemotron makes every glossary decision; DeepSeek translates and tags; GLM reviews.

</details>

<details>
<summary><b>Aren't three copies of one model just agreeing with themselves?</b></summary>

Each proposer has its own stance and its own seed. With one shared seed they never disagreed, so that was changed; the debates that remain are substantive. Proposers from different model families are a planned next step.

</details>

<details>
<summary><b>What does the reviewer add?</b></summary>

Quality beyond terminology: in the canonical run it sent chapter 3 back once (1 major and 3 minor issues) and approved the revision. It also raised a correct dispute about the glossary itself (a banned "Guanlan Data" where the source says 观澜数据), which a human resolved.

</details>

<details>
<summary><b>What was built today?</b></summary>

Everything in this repository, from 10:45 on October 17, 2026, with Claude Code as a coding agent. The commit history shows the order. fableforge, a different project of mine, was an inspiration only; no code was reused.

</details>

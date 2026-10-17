import { Client, Connection } from '@temporalio/client';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadEnv } from './env';
import { TASK_QUEUES, RUN_DATA_DIR, PRICING } from './config';
import type { BookWorkflowResult, ChapterWorkflowResult, TranslationPhaseResult } from './workflows';
import type { CheckSummary } from './checks';
import { ambiguousBannedVariants, bannedHitDetails, crossChapterDrift, nestedTermViolations, renderingCollisions } from './checks';
import { normRendering } from './normalize';
import { writeJsonAtomic } from './activities/io';
import { computeAblation, parseEvalArgs, factCounts, glossaryAgreement, loadBaselineChapters, loadFullChapters, referenceEnglish, referenceGlossary } from './eval';
import { buildReport } from './report';
import { writeAtomic } from './activities/io';
import type { Glossary } from './schemas';
import type { EntityRecord } from './activities/group';
import type { AddressForm } from './activities/tag';

function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

async function connect() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return { connection, client: new Client({ connection }) };
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s: string, n: number) => {
  // CJK characters are double width in a terminal.
  const w = Array.from(s).reduce((a, ch) => a + (/[　-鿿＀-￯“”]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
};

async function start(chapterPath: string, runIdArg?: string) {
  const runId = runIdArg ?? newRunId();
  const { connection, client } = await connect();
  const chapterName = basename(chapterPath, extname(chapterPath));
  const workflowId = `chapter-${runId}-${chapterName}`;
  console.log(`[cli] runId=${runId} workflowId=${workflowId}`);
  const handle = await client.workflow.start('ChapterWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId, args: [{ runId, chapterPath, maxReviewRounds: 0 }] });
  const result = (await handle.result()) as ChapterWorkflowResult;
  console.log('\n[cli] result:');
  console.log(JSON.stringify(result, null, 2));
  const u = result.usage;
  const cached = u.cached_tokens === null ? 'n/a (provider did not report prompt_tokens_details)' : `${u.cached_tokens} (${u.prompt_tokens ? ((100 * u.cached_tokens) / u.prompt_tokens).toFixed(1) : '0.0'}%)`;
  console.log(`\n[cli] tokens: prompt=${u.prompt_tokens} cached=${cached} completion=${u.completion_tokens} model=${u.model}`);
  const json = JSON.parse(await readFile(result.translationPath, 'utf8')) as { paragraphs: { id: string; text: string }[] };
  console.log(`\n[cli] first paragraphs of ${result.englishPath}:`);
  for (const p of json.paragraphs.slice(0, 4)) console.log(`  ${p.id}: ${trunc(p.text, 160)}`);
  await connection.close();
}

async function book(chapterPaths: string[], stopAfter?: 'group' | 'glossary') {
  const runId = newRunId();
  const { connection, client } = await connect();
  const workflowId = `book-${runId}`;
  console.log(`[cli] runId=${runId} workflowId=${workflowId} chapters=${chapterPaths.join(', ')}${stopAfter ? ` stopAfter=${stopAfter}` : ''}`);
  const t0 = Date.now();
  const handle = await client.workflow.start('BookWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId, args: [{ runId, chapterPaths, stopAfter }] });
  const result = (await handle.result()) as BookWorkflowResult;
  console.log(`[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ ...result, translation: result.translation ? { ...result.translation, checks: undefined } : undefined }, null, 2));
  await connection.close();
  await structure(runId);
  if (result.glossaryPath) await glossary(runId);
  if (result.nestedViolationsFixed?.length) console.log(`\n  nested-term re-decisions (v2): ${result.nestedViolationsFixed.join('; ')}`);
  if (result.translation) await evalRun(runId);
}

async function translateBook(glossaryRunId: string, chapterPaths: string[], detach = false, into?: string) {
  const runId = into ?? newRunId();
  const { connection, client } = await connect();
  console.log(`[cli] runId=${runId} glossaryRunId=${glossaryRunId} chapters=${chapterPaths.join(', ')}`);
  const t0 = Date.now();
  const glossaryVersion = await latestGlossaryVersion(glossaryRunId);
  console.log(`[cli] using glossary.v${glossaryVersion}.json`);
  const handle = await client.workflow.start('TranslateBookWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId: into ? `translate-${runId}-${Date.now()}` : `translate-${runId}`, args: [{ runId, glossaryRunId, chapterPaths, glossaryVersion }] });
  if (detach) {
    console.log(`[cli] started workflowId=translate-${runId} (detached). Wait with: cli wait ${runId} ${glossaryRunId}`);
    await connection.close();
    return;
  }
  const result = (await handle.result()) as TranslationPhaseResult & { runId: string };
  console.log(`[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const c of result.chapters) console.log(`  ch ${c.chapterName}: ${c.status} after ${c.rounds.length} review round(s): ${c.rounds.map((r) => `r${r.round} ${r.verdict} [crit ${r.issues.critical} maj ${r.issues.major} min ${r.issues.minor}; lint banned ${r.lint.banned} missing ${r.lint.missing} cjk ${r.lint.cjk}; disputes ${r.termDisputes}]`).join(' → ')}${c.newTermCount ? `; new_terms ${c.newTermCount}` : ''}`);
  await connection.close();
  await evalRun(runId, glossaryRunId);
}

interface UsageRow {
  role: string;
  label: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number | null;
}
async function readUsage(runId: string): Promise<UsageRow[]> {
  try {
    return (await readFile(`${RUN_DATA_DIR}/${runId}/usage.jsonl`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as UsageRow);
  } catch {
    return [];
  }
}
function cost(rows: UsageRow[]): { usd: number; prompt: number; cached: number; completion: number; calls: number } {
  let usd = 0, prompt = 0, cached = 0, completion = 0;
  for (const r of rows) {
    const model = r.model.replace(/^fake:/, '');
    const p = PRICING[model] ?? { prompt: 0, completion: 0, cached: 0 };
    const c = r.cached_tokens ?? 0;
    usd += ((r.prompt_tokens - c) * p.prompt + c * p.cached + r.completion_tokens * p.completion) / 1e6;
    prompt += r.prompt_tokens;
    cached += c;
    completion += r.completion_tokens;
  }
  return { usd, prompt, cached, completion, calls: rows.length };
}

/**
 * Ablation table: baseline (one prompt) | full before review (first drafts) | full after review (final),
 * computed in-process from the run files against the glossary the run used; cost and cached-token rate from
 * usage.jsonl. `--ref` adds the reference-based eval (glossary agreement + fact ledger).
 */
async function evalRun(runId: string, glossaryRunId?: string, withRef = false, glossaryVersion?: number, withHits = false) {
  const dir = `${RUN_DATA_DIR}/${runId}`;
  const ab = await computeAblation(RUN_DATA_DIR, runId, glossaryRunId, glossaryVersion);
  const { chapterNames, glossaryPath, glossary, base, draft, final } = ab;
  const gRun = ab.glossaryRunId;

  const usage = await readUsage(runId);
  const glossaryUsage = gRun !== runId ? await readUsage(gRun) : usage.filter((r) => !['translator', 'baseline', 'reviewer', 'reviser'].includes(r.role));
  const trans = cost(usage.filter((r) => r.role === 'translator'));
  const rev = cost(usage.filter((r) => r.role === 'reviewer'));
  const revise = cost(usage.filter((r) => r.role === 'reviser'));
  const bl = cost(usage.filter((r) => r.role === 'baseline'));
  const gl = cost(glossaryUsage.filter((r) => !['translator', 'baseline', 'reviewer', 'reviser'].includes(r.role)));
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  const W = [38, 20, 22, 22];
  const row = (label: string, a: string, b: string, c: string) => console.log(`  ${pad(label, W[0])} ${pad(a, W[1])} ${pad(b, W[2])} ${c}`);
  const cons = (c: CheckSummary) => pct(c.renderingHits, c.renderingHits + c.bannedHits);
  const bn = (c: CheckSummary) => `${c.bannedHits} (${c.termsWithBanned})`;
  const cov = (c: CheckSummary) => (c.coverage ? `${c.coverage.covered}/${c.coverage.total} (${pct(c.coverage.covered, c.coverage.total)})` : 'n/a');
  console.log(`\n== Ablation — run ${runId} (glossary ${glossaryPath.split('/').slice(-1)[0]} from ${gRun}, ${glossary.entries.length} terms)`);
  row('metric', 'baseline (1 prompt)', 'full, before review', 'full, after review');
  row('glossary adherence (chosen / chosen+banned)', cons(base.summary), cons(draft.summary), cons(final.summary));
  row('chosen-rendering hits', String(base.summary.renderingHits), String(draft.summary.renderingHits), String(final.summary.renderingHits));
  row('banned-variant hits (terms affected)', bn(base.summary), bn(draft.summary), bn(final.summary));
  const dr = (c: typeof base) => `${c.drift.length}${c.drift.length ? ` (${c.drift.map((d) => `${d.source}: ${Object.entries(d.byChapter).map(([ch, f]) => `${ch} ${f.join('/')}`).join('; ')}`).join(' | ')})` : ''}`;
  row('cross-chapter drift (terms rendered differently across chapters)', dr(base), dr(draft), dr(final));
  row('mean distinct renderings per term', base.summary.meanVariants.toFixed(2), draft.summary.meanVariants.toFixed(2), final.summary.meanVariants.toFixed(2));
  row('paragraph term coverage', 'n/a (no paragraph ids)', cov(draft.summary), cov(final.summary));
  row('leftover CJK runs', String(base.summary.cjkLeaks), String(draft.summary.cjkLeaks), String(final.summary.cjkLeaks));
  row('translation cost (USD)', `$${bl.usd.toFixed(4)}`, `$${trans.usd.toFixed(4)}`, `+ $${(rev.usd + revise.usd).toFixed(4)} review/revise`);
  row('translation cached-token rate', pct(bl.cached, bl.prompt), pct(trans.cached, trans.prompt), pct(trans.cached + revise.cached, trans.prompt + revise.prompt));
  row('model calls', String(bl.calls), String(trans.calls), `${rev.calls} reviews, ${revise.calls} revisions`);
  row('glossary build (USD, calls)', '—', `$${gl.usd.toFixed(4)} (${gl.calls})`, '');
  row('total cost (USD)', `$${bl.usd.toFixed(4)}`, `$${(trans.usd + gl.usd).toFixed(4)}`, `$${(trans.usd + rev.usd + revise.usd + gl.usd).toFixed(4)}`);
  const worst = (st: typeof base.stats) => st.filter((x) => x.bannedHits.length).sort((x, y) => y.bannedHits.reduce((a, c) => a + c.count, 0) - x.bannedHits.reduce((a, c) => a + c.count, 0)).slice(0, 6).map((x) => `${x.source}: ${x.bannedHits.map((h) => `${h.variant}×${h.count}`).join(', ')}`).join(' | ') || 'none';
  console.log(`\n  banned variants — baseline: ${worst(base.stats)}`);
  console.log(`  banned variants — before review: ${worst(draft.stats)}`);
  console.log(`  banned variants — after review: ${worst(final.stats)}`);
  const ambiguous = ambiguousBannedVariants(glossary.entries);
  console.log(`  banned variants excluded as ambiguous (also another entry's rendering): ${ambiguous.map((x) => `${x.source} "${x.variant}" (= ${x.conflictsWith})`).join(', ') || 'none'}`);
  if (withHits) {
    for (const [label, chs] of [['baseline', ab.baseChapters], ['full system (final)', ab.finalChapters]] as const) {
      const hits = bannedHitDetails(glossary.entries, chs);
      console.log(`\n  banned hits — ${label} (${hits.length}):`);
      for (const h of hits) console.log(`    ${h.chapter}:${h.line}  "${h.variant}" counted for ${h.term}${h.suspect ? `  [SUSPECT: ${h.suspect}]` : ''}  — ${h.sentence}`);
    }
  }
  console.log('  Note: banned-variant counting is chapter-scoped (a variant for T counts only in chapters where T occurs) and text-level, so a few hits may still be misattributed; use --hits to list them.');
  console.log('  Note: glossary adherence counts the chosen rendering vs KNOWN banned variants only, so the baseline loses points for consistent but different choices (e.g. "Night Voyage"); three chapters is too short for heavy drift, which is what the book-scale design is for.');
  console.log('  Note: adherence counts the chosen rendering vs KNOWN banned variants only; the after-review column is enforced by the loop (approval requires zero lint violations), so the before-review column and the baseline drift are the independent evidence.');

  if (withRef) await evalRef(runId, gRun, glossary, chapterNames, dir);
}

/** Reference-based eval (answer key read here only). */
async function evalRef(runId: string, gRun: string, glossaryUsed: Glossary, chapterNames: string[], dir: string) {
  const ref = await referenceGlossary();
  console.log(`\n== Reference eval (ref/english-reference.md; read by the eval only)`);
  const versions = (await readdir(`${RUN_DATA_DIR}/${gRun}/glossary`)).map((f) => Number(f.match(/^glossary\.v(\d+)\.json$/)?.[1] ?? 0)).filter(Boolean).sort();
  for (const v of versions) {
    const g = JSON.parse(await readFile(`${RUN_DATA_DIR}/${gRun}/glossary/glossary.v${v}.json`, 'utf8')) as Glossary;
    const a = glossaryAgreement(g.entries, ref);
    const human = g.entries.filter((e) => e.decided_by === 'human').length;
    console.log(`  glossary v${v}${v === glossaryUsed.version ? ' (used by this run)' : ''}: ${a.matches}/${a.compared} reference terms match${human ? ` — includes ${human} human resolution(s), made by the reference's author` : ''}; not in our glossary: ${a.notInGlossary.join(', ') || 'none'}`);
    for (const m of a.mismatches) console.log(`    ✗ ${m.source}: ours "${m.ours}" (${m.decided_by}) vs reference ${m.reference.map((r) => `"${r}"`).join(' / ')}`);
  }
  // Cross-chapter drift with the reference's alternates added as known forms (catches e.g. 师父 → "mentor").
  const extra = new Map<string, string[]>();
  for (const row of ref) row.sources.forEach((src, i) => extra.set(src, [...(extra.get(src) ?? []), ...row.alternates[i]]));
  const ab2 = await computeAblation(RUN_DATA_DIR, runId, gRun, glossaryUsed.version);
  const dAll = (chs: typeof ab2.baseChapters) => crossChapterDrift(glossaryUsed.entries, chs, extra);
  const fmt = (d: ReturnType<typeof dAll>) => `${d.length}${d.length ? ` (${d.map((x) => `${x.source}: ${Object.entries(x.byChapter).map(([c, f]) => `${c} ${f.join('/')}`).join('; ')}`).join(' | ')})` : ''}`;
  console.log(`\n  cross-chapter drift incl. reference alternates as known forms — baseline: ${fmt(dAll(ab2.baseChapters))}; full system: ${fmt(dAll(ab2.finalChapters))}`);
  const refEn = await referenceEnglish();
  const refCounts = factCounts(refEn);
  const baseText = (await loadBaselineChapters(dir, chapterNames)).map((c) => c.en).join('\n');
  const fullText = (await loadFullChapters(dir, chapterNames, chapterNames.map(() => ''), false).catch(() => [] as { en: string }[])).map((c) => c.en).join('\n');
  const fullTextSafe = fullText || (await Promise.all(chapterNames.map((n) => readFile(`${dir}/chapters/${n}/translation.en.txt`, 'utf8')))).join('\n');
  const bc = factCounts(baseText);
  const fc = factCounts(fullTextSafe);
  console.log(`\n  Fact ledger (occurrences; total = count in the reference translation)`);
  console.log(`  ${pad('fact', 20)} ${pad('reference', 10)} ${pad('baseline', 10)} full`);
  let bOk = 0, fOk = 0, n = 0;
  for (const f of Object.keys(refCounts)) {
    const total = refCounts[f];
    if (!total) {
      console.log(`  ${pad(f, 20)} ${pad('0', 10)} ${pad(`${bc[f]} (n/a)`, 10)} ${fc[f]} (n/a: not stated in the reference)`);
      continue;
    }
    n++;
    if (bc[f] >= total) bOk++;
    if (fc[f] >= total) fOk++;
    console.log(`  ${pad(f, 20)} ${pad(String(total), 10)} ${pad(`${bc[f]}/${total}`, 10)} ${fc[f]}/${total}`);
  }
  console.log(`  facts fully present: baseline ${bOk}/${n}, full ${fOk}/${n}`);
}

/** Block until a detached translate run finishes, then print the chapter summary and the ablation. */
async function waitRun(runId: string, glossaryRunId?: string) {
  const { connection, client } = await connect();
  const handle = client.workflow.getHandle(`translate-${runId}`);
  const t0 = Date.now();
  const result = (await handle.result()) as TranslationPhaseResult & { runId: string; glossaryRunId: string };
  console.log(`[cli] translate-${runId} completed (waited ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const c of result.chapters) console.log(`  ch ${c.chapterName}: ${c.status} after ${c.rounds.length} review round(s): ${c.rounds.map((r) => `r${r.round} ${r.verdict} [crit ${r.issues.critical} maj ${r.issues.major} min ${r.issues.minor}; lint ${r.lint.banned + r.lint.missing + r.lint.cjk}]`).join(' → ')}`);
  await connection.close();
  await evalRun(runId, glossaryRunId ?? result.glossaryRunId);
}

async function latestGlossaryVersion(runId: string): Promise<number> {
  const files = await readdir(`${RUN_DATA_DIR}/${runId}/glossary`);
  return Math.max(...files.map((f) => Number(f.match(/^glossary\.v(\d+)\.json$/)?.[1] ?? 0)));
}

/** Find a reviewer term dispute about this source in any translation run that used this glossary run. */
async function findDispute(glossaryRunId: string, source: string): Promise<string | null> {
  const runs = (await readdir(RUN_DATA_DIR)).sort().reverse();
  for (const run of runs) {
    let chapters: string[] = [];
    try {
      chapters = await readdir(`${RUN_DATA_DIR}/${run}/chapters`);
    } catch {
      continue;
    }
    for (const ch of chapters) {
      let files: string[] = [];
      try {
        files = (await readdir(`${RUN_DATA_DIR}/${run}/chapters/${ch}`)).filter((f) => /^review\.r\d+\.json$/.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        const r = JSON.parse(await readFile(`${RUN_DATA_DIR}/${run}/chapters/${ch}/${f}`, 'utf8')) as { term_disputes?: { source: string; current_rendering: string; proposed: string; reason: string }[] };
        const t = JSON.parse(await readFile(`${RUN_DATA_DIR}/${run}/chapters/${ch}/translation.json`, 'utf8').catch(() => '{}')) as { glossary?: string | null };
        if (!t.glossary?.includes(glossaryRunId)) continue;
        for (const d of r.term_disputes ?? []) {
          if (d.source.includes(source) || source.includes(d.source)) return `reviewer dispute in run ${run} ch ${ch} ${f}: ${d.source} ${d.current_rendering} → ${d.proposed}: ${d.reason.slice(0, 200)}`;
        }
      }
    }
  }
  return null;
}

/**
 * Human resolution: set one entry's rendering (and optionally unban a variant), decided_by "human",
 * needs_human false, resolved_from citing the flag or dispute it answers; write glossary.v{N+1}.json
 * (or amend the latest with --same-version) and re-run the nested-term and collision checks.
 */
async function resolve(runId: string, source: string, rendering: string, opts: { unban?: string; sameVersion?: boolean; note?: string }) {
  const latest = await latestGlossaryVersion(runId);
  const dir = `${RUN_DATA_DIR}/${runId}/glossary`;
  const g = JSON.parse(await readFile(`${dir}/glossary.v${latest}.json`, 'utf8')) as Glossary;
  const e = g.entries.find((x) => x.source === source);
  if (!e) throw new Error(`no glossary entry for ${source} in v${latest}`);
  const before = { rendering: e.rendering, banned: [...e.banned], needs_human: e.needs_human, reason: e.needs_human_reason };
  const dispute = await findDispute(runId, source);
  const answers = before.needs_human ? `needs_human flag on ${source}: ${before.reason}` : dispute ?? (opts.note ? `operator note: ${opts.note}` : 'no open flag or dispute; editorial decision');
  e.rendering = rendering.trim();
  e.decided_by = 'human';
  e.needs_human = false;
  e.needs_human_reason = null;
  e.resolved_from = answers;
  if (opts.unban) {
    const k = opts.unban.trim().toLowerCase();
    e.banned = e.banned.filter((b) => b.trim().toLowerCase() !== k);
  }
  // The chosen rendering can never be in the banned list.
  e.banned = e.banned.filter((b) => b.trim().toLowerCase() !== e.rendering.toLowerCase());
  e.code_notes.push(`human: "${before.rendering}" → "${e.rendering}"${opts.unban ? `; unbanned "${opts.unban}"` : ''}${opts.note ? `; ${opts.note}` : ''}`);
  const version = opts.sameVersion ? latest : latest + 1;
  const out: Glossary = { ...g, version, entries: g.entries };
  await writeJsonAtomic(`${dir}/glossary.v${version}.json`, out);
  console.log(`[resolve] ${source}: "${before.rendering}" → "${e.rendering}"${opts.unban ? ` (unbanned "${opts.unban}")` : ''} → glossary.v${version}.json`);
  console.log(`  resolved_from: ${answers}`);
  const nested = nestedTermViolations(g.entries);
  const collisions = renderingCollisions(g.entries);
  console.log(`  checks: ${nested.length} nested-term violation(s)${nested.length ? ': ' + nested.map((v) => `${v.source} "${v.rendering}" must contain "${v.requiredRendering}" (${v.within})`).join('; ') : ''}; ${collisions.length} rendering collision(s)${collisions.length ? ': ' + collisions.map((c) => `${c.rendering} ← ${c.sources.join(', ')}`).join('; ') : ''}`);
  const stillHuman = g.entries.filter((x) => x.needs_human).map((x) => x.source);
  console.log(`  needs_human remaining: ${stillHuman.length ? stillHuman.join(', ') : 'none'}`);
}

/** Incremental mode: add one chapter to a run; the glossary grows by one version. */
async function addChapter(runId: string, chapterPath: string) {
  const { connection, client } = await connect();
  let previousVersion = 0;
  try {
    previousVersion = await latestGlossaryVersion(runId);
  } catch {
    /* new run */
  }
  const chapterName = basename(chapterPath, extname(chapterPath));
  console.log(`[cli] add-chapter runId=${runId} chapter=${chapterName} previousVersion=${previousVersion}`);
  const t0 = Date.now();
  const handle = await client.workflow.start('AddChapterWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId: `add-${runId}-${chapterName}`, args: [{ runId, chapterPath, previousVersion }] });
  const r = (await handle.result()) as { version: number; glossaryPath: string; changelog: { entitiesTotal: number; newEntities: string[]; newAliases: { alias: string; entity: string }[]; debates: number; precedentsCited: string[]; calls: number; costUsd: number }; chapter: { status: string; rounds: { verdict: string }[] } };
  const c = r.changelog;
  console.log(`[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → glossary.v${r.version}.json: ${c.entitiesTotal} entities total, +${c.newEntities.length} new (${c.newEntities.join(', ') || '—'}), +${c.newAliases.length} aliases (${c.newAliases.map((a) => `${a.alias}→${a.entity}`).join(', ') || '—'}), ${c.debates} debated, precedents cited: ${c.precedentsCited.join(', ') || '—'}, ${c.calls} calls, $${c.costUsd.toFixed(4)}; chapter ${r.chapter.status} after ${r.chapter.rounds.length} review round(s)`);
  await connection.close();
}

async function growth(runId: string) {
  const log = JSON.parse(await readFile(`${RUN_DATA_DIR}/${runId}/glossary/changelog.json`, 'utf8')) as { version: number; chapter: string; entitiesTotal: number; newEntities: string[]; newAliases: { alias: string; entity: string }[]; debates: number; precedentsCited: string[]; calls: number; costUsd: number }[];
  console.log(`\n== Glossary growth — ${runId}`);
  console.log(`  ${pad('version', 8)} ${pad('chapter', 8)} ${pad('entities', 9)} ${pad('new', 5)} ${pad('aliases', 8)} ${pad('debates', 8)} ${pad('calls', 6)} ${pad('cost', 9)} new entities / aliases / precedents`);
  for (const l of log.sort((a, b) => a.version - b.version)) {
    console.log(`  ${pad('v' + l.version, 8)} ${pad(l.chapter, 8)} ${pad(String(l.entitiesTotal), 9)} ${pad(String(l.newEntities.length), 5)} ${pad(String(l.newAliases.length), 8)} ${pad(String(l.debates), 8)} ${pad(String(l.calls), 6)} ${pad('$' + l.costUsd.toFixed(4), 9)} ${l.newEntities.join(', ') || '—'} / ${l.newAliases.map((a) => `${a.alias}→${a.entity}`).join(', ') || '—'} / ${l.precedentsCited.join(', ') || '—'}`);
  }
}

async function structure(runId: string) {
  const dir = `${RUN_DATA_DIR}/${runId}/glossary`;
  const forms = JSON.parse(await readFile(`${dir}/address-forms.json`, 'utf8')) as AddressForm[];
  const { entities, kept_separate } = JSON.parse(await readFile(`${dir}/entities.json`, 'utf8')) as { entities: EntityRecord[]; kept_separate: { sources: string[]; reason: string }[] };

  console.log(`\n== Address forms (speaker → addressee: form) — ${runId}`);
  if (!forms.length) console.log('  (none observed)');
  for (const f of forms) console.log(`  ${pad(f.speaker, 8)} → ${pad(f.addressee, 8)}: ${pad(f.form, 8)} ×${f.count}  ${f.paragraph_ids.slice(0, 4).join(', ')}${f.paragraph_ids.length > 4 ? ', …' : ''}`);

  console.log(`\n== Entities (${entities.length})`);
  console.log(`  ${pad('source', 10)} ${pad('type', 13)} aliases`);
  for (const e of [...entities].sort((a, b) => a.canonical_source.localeCompare(b.canonical_source, 'zh'))) {
    const al = e.aliases.map((a) => `${a.source}(${a.kind}${a.used_by ? `, by ${a.used_by}` : ''})`).join(', ') || '—';
    console.log(`  ${pad(e.canonical_source, 10)} ${pad(e.type, 13)} ${al}`);
    console.log(`  ${pad('', 10)} ${pad('', 13)} evidence: ${trunc(e.evidence, 110)}`);
  }

  console.log(`\n== Kept separate (${kept_separate.length})`);
  for (const k of kept_separate) console.log(`  ${k.sources.join(' | ')}: ${trunc(k.reason, 140)}`);
  if (!kept_separate.length) console.log('  (none)');
}

async function glossary(runId: string, versionArg?: string) {
  const version = versionArg ?? ((await readdir(`${RUN_DATA_DIR}/${runId}/glossary`)).includes('glossary.v2.json') ? '2' : '1');
  const g = JSON.parse(await readFile(`${RUN_DATA_DIR}/${runId}/glossary/glossary.v${version}.json`, 'utf8')) as Glossary;
  console.log(`\n== Glossary v${version} — ${runId}`);
  console.log(`  ${pad('source', 10)} ${pad('rendering', 22)} ${pad('aliases', 34)} ${pad('banned', 26)} ${pad('decided_by', 13)} rationale`);
  for (const e of g.entries) {
    const al = e.alias_renderings.map((a) => `${a.source}→${a.rendering}`).join(', ') || '—';
    const flag = e.needs_human ? ' ⚠' : e.decided_by === 'human' ? ' ✎' : '';
    console.log(`  ${pad(e.source, 10)} ${pad(trunc(e.rendering, 21), 22)} ${pad(trunc(al, 33), 34)} ${pad(trunc(e.banned.join(', ') || '—', 25), 26)} ${pad(e.decided_by + flag, 13)} ${trunc(e.rationale, 90)}`);
  }
  const by = (k: string) => g.entries.filter((e) => e.decided_by === k).length;
  const normalizedAgree = g.entries.filter((e) => e.code_notes.some((n) => n.startsWith('agreement after normalization'))).length;
  console.log(`\n  ${g.entries.length} entities, ${by('agreement')} by agreement (${by('agreement') - normalizedAgree} raw, ${normalizedAgree} after normalization), ${by('terminologist')} debated, ${g.entries.filter((e) => e.needs_human).length} needs_human`);
  const notes = g.entries.flatMap((e) => e.code_notes.map((n) => `${e.source}: ${n}`));
  if (notes.length) console.log(`  code notes (${notes.length}):\n    ${notes.join('\n    ')}`);
}

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'start' && rest[0]) return start(rest[0], rest[1]);
  if (cmd === 'book' && rest.length) {
    const stopIdx = rest.indexOf('--stop-after');
    const stopAfter = stopIdx >= 0 ? (rest[stopIdx + 1] as 'group' | 'glossary') : undefined;
    const files = stopIdx >= 0 ? rest.filter((_, i) => i !== stopIdx && i !== stopIdx + 1) : rest;
    return book(files, stopAfter);
  }
  if (cmd === 'structure' && rest[0]) return structure(rest[0]);
  if (cmd === 'add-chapter' && rest.length >= 2) return addChapter(rest[0], rest[1]);
  if (cmd === 'growth' && rest[0]) return growth(rest[0]);
  if (cmd === 'resolve' && rest.length >= 3) {
    const unbanIdx = rest.indexOf('--unban');
    const noteIdx = rest.indexOf('--note');
    return resolve(rest[0], rest[1], rest[2], { unban: unbanIdx >= 0 ? rest[unbanIdx + 1] : undefined, sameVersion: rest.includes('--same-version'), note: noteIdx >= 0 ? rest[noteIdx + 1] : undefined });
  }
  if (cmd === 'translate' && rest.length >= 2) {
    const detach = rest.includes('--detach');
    const intoIdx = rest.indexOf('--into');
    const into = intoIdx >= 0 ? rest[intoIdx + 1] : undefined;
    const args = rest.filter((a, i) => a !== '--detach' && (intoIdx < 0 || (i !== intoIdx && i !== intoIdx + 1)));
    return translateBook(args[0], args.slice(1), detach, into);
  }
  if (cmd === 'wait' && rest[0]) return waitRun(rest[0], rest[1]);
  if (cmd === 'report' && rest[0]) {
    const gvIdx = rest.indexOf('--glossary-version');
    const gv = gvIdx >= 0 ? Number(rest[gvIdx + 1]) : undefined;
    const args = rest.filter((a, i) => gvIdx < 0 || (i !== gvIdx && i !== gvIdx + 1));
    const html = await buildReport(RUN_DATA_DIR, args[0], args[1], gv);
    const out = `${RUN_DATA_DIR}/${rest[0]}/report.html`;
    await writeAtomic(out, html);
    console.log(`[cli] wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
    return;
  }
  if (cmd === 'eval' && rest[0]) {
    const a = parseEvalArgs(rest);
    return evalRun(a.runId, a.glossaryRunId, a.withRef, a.glossaryVersion, a.withHits);
  }
  if (cmd === 'glossary' && rest[0]) return glossary(rest[0], rest[1]);
  console.error('usage:\n  cli start <chapter-file> [runId]\n  cli book <chapter-files...> [--stop-after group|glossary]\n  cli translate <glossaryRunId> <chapter-files...> [--detach] [--into <existingRunId>]\n  cli wait <runId> [glossaryRunId]\n  cli structure <runId>\n  cli add-chapter <runId> <chapter-file>   (incremental mode; glossary grows one version per chapter)\n  cli growth <runId>\n  cli resolve <runId> <source> <rendering> [--unban <variant>] [--same-version] [--note <text>]\n  cli glossary <runId> [version]\n  cli eval <runId> [glossaryRunId] [--ref]\n  cli report <runId> [glossaryRunId] [--glossary-version N]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

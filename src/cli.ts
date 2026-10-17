import { Client, Connection } from '@temporalio/client';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadEnv } from './env';
import { TASK_QUEUES, RUN_DATA_DIR, PRICING } from './config';
import type { BookWorkflowResult, ChapterWorkflowResult, TranslationPhaseResult } from './workflows';
import type { CheckSummary } from './checks';
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
  const handle = await client.workflow.start('ChapterWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId, args: [{ runId, chapterPath }] });
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

async function translateBook(glossaryRunId: string, chapterPaths: string[]) {
  const runId = newRunId();
  const { connection, client } = await connect();
  console.log(`[cli] runId=${runId} glossaryRunId=${glossaryRunId} chapters=${chapterPaths.join(', ')}`);
  const t0 = Date.now();
  const handle = await client.workflow.start('TranslateBookWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId: `translate-${runId}`, args: [{ runId, glossaryRunId, chapterPaths }] });
  const result = (await handle.result()) as TranslationPhaseResult & { runId: string };
  console.log(`[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify({ ...result, checks: undefined }, null, 2));
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

/** Ablation table: one-prompt baseline vs the full system, from checks/*.json and usage.jsonl. */
async function evalRun(runId: string, glossaryRunId?: string) {
  const dir = `${RUN_DATA_DIR}/${runId}`;
  const full = JSON.parse(await readFile(`${dir}/checks/full.json`, 'utf8')) as { summary: CheckSummary; stats: { source: string; renderingHits: number; bannedHits: { variant: string; count: number }[]; variantsUsed: string[]; coverage?: { covered: number; total: number } }[]; leaks: unknown[] };
  const base = JSON.parse(await readFile(`${dir}/checks/baseline.json`, 'utf8')) as typeof full;
  const usage = await readUsage(runId);
  const glossaryUsage = glossaryRunId && glossaryRunId !== runId ? await readUsage(glossaryRunId) : usage.filter((r) => !['translator', 'baseline'].includes(r.role));
  const trans = cost(usage.filter((r) => r.role === 'translator'));
  const bl = cost(usage.filter((r) => r.role === 'baseline'));
  const gl = cost(glossaryUsage.filter((r) => !['translator', 'baseline'].includes(r.role)));
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  const f = full.summary, b = base.summary;
  const row = (label: string, fv: string, bv: string) => console.log(`  ${pad(label, 34)} ${pad(bv, 22)} ${fv}`);
  console.log(`\n== Ablation — run ${runId}${glossaryRunId ? ` (glossary from ${glossaryRunId})` : ''}`);
  console.log(`  ${pad('metric', 34)} ${pad('baseline (1 prompt)', 22)} full system`);
  row('glossary terms checked', String(f.terms), String(b.terms));
  row('term consistency (chosen / chosen+banned)', pct(f.renderingHits, f.renderingHits + f.bannedHits), pct(b.renderingHits, b.renderingHits + b.bannedHits));
  row('chosen-rendering hits', String(f.renderingHits), String(b.renderingHits));
  row('banned-variant hits (terms affected)', `${f.bannedHits} (${f.termsWithBanned})`, `${b.bannedHits} (${b.termsWithBanned})`);
  row('mean distinct renderings per term', f.meanVariants.toFixed(2), b.meanVariants.toFixed(2));
  row('paragraph term coverage', f.coverage ? `${f.coverage.covered}/${f.coverage.total} (${pct(f.coverage.covered, f.coverage.total)})` : 'n/a', 'n/a (no paragraph ids)');
  row('leftover CJK runs', String(f.cjkLeaks), String(b.cjkLeaks));
  row('rendering collisions / nested violations', `${f.collisions} / ${f.nestedViolations}`, '—');
  row('translation cost (USD)', `$${trans.usd.toFixed(4)}`, `$${bl.usd.toFixed(4)}`);
  row('translation cached-token rate', pct(trans.cached, trans.prompt), pct(bl.cached, bl.prompt));
  row('translation tokens (prompt / completion)', `${trans.prompt} / ${trans.completion}`, `${bl.prompt} / ${bl.completion}`);
  row('glossary build cost (USD, calls)', `$${gl.usd.toFixed(4)} (${gl.calls})`, '—');
  row('total cost (USD)', `$${(trans.usd + gl.usd).toFixed(4)}`, `$${bl.usd.toFixed(4)}`);
  const worst = (st: typeof full.stats) => st.filter((x) => x.bannedHits.length).sort((x, y) => y.bannedHits.reduce((a, c) => a + c.count, 0) - x.bannedHits.reduce((a, c) => a + c.count, 0)).slice(0, 6);
  console.log(`\n  baseline banned variants: ${worst(base.stats).map((x) => `${x.source}: ${x.bannedHits.map((h) => `${h.variant}×${h.count}`).join(', ')}`).join(' | ') || 'none'}`);
  console.log(`  full-system banned variants: ${worst(full.stats).map((x) => `${x.source}: ${x.bannedHits.map((h) => `${h.variant}×${h.count}`).join(', ')}`).join(' | ') || 'none'}`);
  const uncovered = full.stats.filter((x) => x.coverage && x.coverage.covered < x.coverage.total).map((x) => `${x.source} ${x.coverage!.covered}/${x.coverage!.total}`);
  if (uncovered.length) console.log(`  full-system paragraphs missing a rendering: ${uncovered.join(', ')}`);
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
    const flag = e.needs_human ? ' ⚠' : '';
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
  if (cmd === 'translate' && rest.length >= 2) return translateBook(rest[0], rest.slice(1));
  if (cmd === 'eval' && rest[0]) return evalRun(rest[0], rest[1]);
  if (cmd === 'glossary' && rest[0]) return glossary(rest[0], rest[1]);
  console.error('usage:\n  cli start <chapter-file> [runId]\n  cli book <chapter-files...> [--stop-after group|glossary]\n  cli translate <glossaryRunId> <chapter-files...>\n  cli structure <runId>\n  cli glossary <runId> [version]\n  cli eval <runId> [glossaryRunId]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

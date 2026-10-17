import { Client, Connection } from '@temporalio/client';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadEnv } from './env';
import { TASK_QUEUES, RUN_DATA_DIR } from './config';
import type { BookWorkflowResult, ChapterWorkflowResult } from './workflows';
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

async function book(chapterPaths: string[], stopAfter?: 'group') {
  const runId = newRunId();
  const { connection, client } = await connect();
  const workflowId = `book-${runId}`;
  console.log(`[cli] runId=${runId} workflowId=${workflowId} chapters=${chapterPaths.join(', ')}${stopAfter ? ` stopAfter=${stopAfter}` : ''}`);
  const t0 = Date.now();
  const handle = await client.workflow.start('BookWorkflow', { taskQueue: TASK_QUEUES.workflows, workflowId, args: [{ runId, chapterPaths, stopAfter }] });
  const result = (await handle.result()) as BookWorkflowResult;
  console.log(`[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result, null, 2));
  await connection.close();
  await structure(runId);
  if (result.glossaryPath) await glossary(runId);
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

async function glossary(runId: string) {
  const g = JSON.parse(await readFile(`${RUN_DATA_DIR}/${runId}/glossary/glossary.v1.json`, 'utf8')) as Glossary;
  console.log(`\n== Glossary v1 — ${runId}`);
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
    const stopAfter = stopIdx >= 0 ? (rest[stopIdx + 1] as 'group') : undefined;
    const files = stopIdx >= 0 ? rest.filter((_, i) => i !== stopIdx && i !== stopIdx + 1) : rest;
    return book(files, stopAfter);
  }
  if (cmd === 'structure' && rest[0]) return structure(rest[0]);
  if (cmd === 'glossary' && rest[0]) return glossary(rest[0]);
  console.error('usage:\n  cli start <chapter-file> [runId]\n  cli book <chapter-files...> [--stop-after group]\n  cli structure <runId>\n  cli glossary <runId>');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

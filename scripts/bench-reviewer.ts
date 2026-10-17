// Compare candidate model families on (A) translating chapter 1 and (B) reviewing a translation
// with planted defects. Usage: bunx tsx scripts/bench-reviewer.ts <translation.json> model1 model2 ...
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import { chatJson } from '../src/llm';
import { TranslationSchema } from '../src/schemas';
import { formatParagraphs, splitParagraphs } from '../src/text';
import { EVAL_SEED } from '../src/config';

const ReviewSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['minor', 'major']),
      category: z.enum(['omission', 'mistranslation', 'leftover_source', 'fluency', 'terminology', 'other']),
      note: z.string(),
    }),
  ),
  overall_score: z.number().describe('1-10'),
});

const REVIEWER_BRIEF = `You are a senior literary translation reviewer (Chinese -> English). You judge quality only.
For each paragraph compare source and translation. Report only real problems: omitted or added content,
mistranslations (including wrong numbers), source-language characters left in the output, unnatural English,
or inconsistent rendering of a name/term within the chapter. Do not report stylistic preferences.
Use the paragraph id. Return JSON only.`;

const TRANSLATOR_BRIEF = `You are a literary translator rendering a Chinese novel into fluent, natural English.
Translate every paragraph; one entry per source paragraph with the same id. Do not leave Chinese characters.
Keep names, titles, and invented terms consistent. Return JSON only.`;

type Para = { id: string; text: string };

function plantDefects(paras: Para[]): { planted: Para[]; expected: { id: string; what: string; test: (note: string, cat: string) => boolean }[] } {
  const planted = paras.map((p) => ({ ...p }));
  const expected: ReturnType<typeof plantDefects>['expected'] = [];
  // 1) omission: drop the last sentence of a long paragraph
  const longIdx = planted.findIndex((p) => p.text.split(/(?<=[.!?"])\s+/).length >= 3);
  if (longIdx >= 0) {
    const sentences = planted[longIdx].text.split(/(?<=[.!?"])\s+/);
    planted[longIdx].text = sentences.slice(0, -1).join(' ');
    expected.push({ id: planted[longIdx].id, what: 'omitted last sentence', test: (n, c) => c === 'omission' || /omit|missing|drop|left out/i.test(n) });
  }
  // 2) wrong number
  const NUM_RE = /3,?412|three thousand[a-z ,-]{0,30}twelve/i;
  const numIdx = planted.findIndex((p) => NUM_RE.test(p.text));
  if (numIdx >= 0) {
    planted[numIdx].text = planted[numIdx].text.replace(NUM_RE, '3,421');
    expected.push({ id: planted[numIdx].id, what: 'number 3,412 -> 3,421', test: (n, c) => /3,?421|3,?412|number|figure|digit/i.test(n) || c === 'mistranslation' });
  }
  // 3) leftover source characters
  const lastIdx = planted.length - 2;
  planted[lastIdx].text = planted[lastIdx].text + ' 夜航';
  expected.push({ id: planted[lastIdx].id, what: 'leftover CJK 夜航', test: (n, c) => c === 'leftover_source' || /chinese|source|夜航|character/i.test(n) });
  return { planted, expected };
}

async function main() {
  loadEnv();
  const [translationPath, ...models] = process.argv.slice(2);
  const skipTranslate = process.env.BENCH_SKIP_TRANSLATE === '1';
  const reviewThinking = process.env.REVIEW_THINKING !== '0';
  const lowEffort = process.env.LOW_EFFORT === '1';
  const templateKwargs = lowEffort ? { low_effort: true } : undefined;
  const extra = lowEffort ? { reasoning_effort: 'low' } : undefined;
  console.log(`options: skipTranslate=${skipTranslate} reviewThinking=${reviewThinking} lowEffort=${lowEffort} timeout=${process.env.LLM_TIMEOUT_MS ?? 180000}ms`);
  const source = await readFile('data/zh/01.txt', 'utf8');
  const srcParas = splitParagraphs(source);
  const base = JSON.parse(await readFile(translationPath, 'utf8')) as { paragraphs: Para[] };
  const { planted, expected } = plantDefects(base.paragraphs);
  console.log('Planted defects:', expected.map((e) => `${e.id}: ${e.what}`).join(' | '));

  for (const model of models) {
    console.log(`\n==================== ${model} ====================`);
    // (A) translation, thinking off
    if (!skipTranslate) try {
      const t0 = Date.now();
      const tr = await chatJson(
        { model, system: TRANSLATOR_BRIEF, user: formatParagraphs(srcParas), schemaName: 'translation', maxTokens: 4096, seed: EVAL_SEED, enableThinking: false },
        TranslationSchema,
      );
      const got = tr.data.paragraphs;
      const ids = got.map((p) => p.id);
      const idsOk = srcParas.every((p) => ids.includes(p.id)) && ids.length === srcParas.length;
      const cjk = got.filter((p) => /[一-鿿]/.test(p.text)).length;
      const text = got.map((p) => p.text).join('\n');
      const terms = Array.from(text.matchAll(/Shen [A-Z][a-z]+|Lu [A-Z][a-z]+|[Gg]r[ae]y[ -]?[Ll]ist|Night[A-Za-z ]{0,10}|Director Zhou|Ms\.? Zhou|Zhou [A-Z][a-z]+|[Rr]eview [Tt]eam|[Vv]erification [Tt]eam/g)).map((m) => m[0].trim());
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      console.log(`[A translate] ${((Date.now() - t0) / 1000).toFixed(1)}s ids_ok=${idsOk} leftover_cjk_paras=${cjk} usage=${JSON.stringify(tr.usage)}`);
      console.log('  terms:', Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', '));
      for (const p of got.slice(1, 4)) console.log(`  ${p.id}: ${p.text.slice(0, 150)}`);
    } catch (e) {
      console.log('[A translate] FAILED:', (e as Error).message);
    }
    // (B) review with planted defects, thinking on
    try {
      const t0 = Date.now();
      const user = `SOURCE (Chinese):\n\n${formatParagraphs(srcParas)}\n\nTRANSLATION (English):\n\n${formatParagraphs(planted)}`;
      const rv = await chatJson(
        { model, system: REVIEWER_BRIEF, user, schemaName: 'review', maxTokens: 16384, seed: EVAL_SEED, enableThinking: reviewThinking, templateKwargs, extra },
        ReviewSchema,
      );
      const caught = expected.map((e) => ({ ...e, hit: rv.data.issues.some((i) => i.id === e.id && e.test(i.note, i.category)) }));
      const other = rv.data.issues.filter((i) => !expected.some((e) => e.id === i.id));
      console.log(`[B review] ${((Date.now() - t0) / 1000).toFixed(1)}s score=${rv.data.overall_score} issues=${rv.data.issues.length} caught=${caught.filter((c) => c.hit).length}/${caught.length} other_issues=${other.length} usage=${JSON.stringify(rv.usage)}`);
      for (const c of caught) console.log(`  ${c.hit ? 'HIT ' : 'MISS'} ${c.id} ${c.what}`);
      for (const i of rv.data.issues) console.log(`  - ${i.id} [${i.severity}/${i.category}] ${i.note.slice(0, 140)}`);
    } catch (e) {
      console.log('[B review] FAILED:', (e as Error).message);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Re-issue the alias-grouper call from an existing run's files, to diagnose runaway output.
// Usage: bunx tsx scripts/repro-group.ts <runId> [maxTokens] [temperature]
import { readFile } from 'node:fs/promises';
import { loadEnv } from '../src/env';
import { chatJson } from '../src/llm';
import { grouperPrompt, renderTaggedParagraph } from '../src/prompts';
import { AliasGroupsSchema, type Extraction, type TaggedChapter } from '../src/schemas';
import { formatAddressForms, type AddressForm } from '../src/activities/tag';
import { MODELS, EVAL_SEED } from '../src/config';
import { verifyExtraction } from '../src/extract';

async function main() {
  loadEnv();
  const [runId, maxTok = '4096', temp = '0.2'] = process.argv.slice(2);
  const dir = `run-data/${runId}`;
  const extraction = JSON.parse(await readFile(`${dir}/glossary/extraction.json`, 'utf8')) as Extraction;
  const tagged: (TaggedChapter & { chapter: string })[] = [];
  for (const ch of ['01', '02', '03']) tagged.push(JSON.parse(await readFile(`${dir}/chapters/${ch}/tagged.json`, 'utf8')));
  const forms: AddressForm[] = [];
  for (const ch of ['01', '02', '03']) forms.push(...(JSON.parse(await readFile(`${dir}/chapters/${ch}/address-forms.json`, 'utf8')) as AddressForm[]));
  const all = tagged.flatMap((t) => t.paragraphs.map((p) => ({ id: `${t.chapter}.${p.id}`, text: p.segments.map((s) => s.text).join('') })));
  const v = verifyExtraction(extraction.items, all);
  console.log(`verifyExtraction: kept ${v.kept.length}, dropped ${v.dropped.length}: ${v.dropped.map((d) => d.source + ' (' + d.why + ')').join('; ')}`);
  extraction.items = v.kept;
  const snippets = (source: string) => {
    const out: string[] = [];
    for (const t of tagged) for (const p of t.paragraphs) if (p.segments.map((s) => s.text).join('').includes(source) && out.length < 3) out.push(`[${t.chapter}.${p.id}] ${renderTaggedParagraph(p)}`);
    return out;
  };
  const itemsBlock = extraction.items
    .map((it) => `ITEM: ${it.source} (${it.type})${it.refers_to ? ` refers_to=${it.refers_to}` : ''} needs_fixed_rendering=${it.needs_fixed_rendering}\n  reason: ${it.reason}\n  paragraphs: ${it.paragraph_ids.join(', ')}\n  contexts:\n${snippets(it.source).map((c) => `    ${c}`).join('\n') || '    (none found)'}`)
    .join('\n\n');
  const prompt = grouperPrompt(itemsBlock, formatAddressForms(forms));
  console.log(`prompt chars: system=${prompt.system.length} user=${prompt.user.length}; items=${extraction.items.length}`);
  const t0 = Date.now();
  try {
    const res = await chatJson({ model: process.env.MODEL ?? MODELS.smart, ...prompt, schemaName: 'alias_groups', maxTokens: Number(maxTok), seed: EVAL_SEED, temperature: Number(temp), enableThinking: false, extra: process.env.REP_PEN ? { repetition_penalty: Number(process.env.REP_PEN) } : undefined }, AliasGroupsSchema);
    console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${res.data.entities.length} entities, ${res.data.kept_separate.length} kept separate; usage=${JSON.stringify(res.usage)}`);
    for (const e of res.data.entities) console.log(`  ${e.canonical_source}: ${e.aliases.map((a) => `${a.source}(${a.kind}${a.used_by ? ', by ' + a.used_by : ''})`).join(', ') || '—'}`);
  } catch (e) {
    console.log(`FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(e as Error).message.slice(0, 1500)}`);
  }
}
main();

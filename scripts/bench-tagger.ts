// Tag chapters with a given model through the same exactness check the activity uses.
// Usage: bunx tsx scripts/bench-tagger.ts <model> <rounds> <chapter files...>
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadEnv } from '../src/env';
import { chatJson } from '../src/llm';
import { taggerPrompt } from '../src/prompts';
import { TaggedChapterSchema } from '../src/schemas';
import { formatParagraphs, splitParagraphs } from '../src/text';
import { alignSegments } from '../src/align';
import { EVAL_SEED } from '../src/config';

async function main() {
  loadEnv();
  const [model, roundsArg, ...files] = process.argv.slice(2);
  const rounds = Number(roundsArg);
  let ok = 0, total = 0;
  for (let r = 0; r < rounds; r++) {
    await Promise.all(files.map(async (f) => {
      const src = await readFile(f, 'utf8');
      const paras = splitParagraphs(src);
      const t0 = Date.now();
      total++;
      try {
        const res = await chatJson({ model, ...taggerPrompt(formatParagraphs(paras)), schemaName: 'tagging', maxTokens: 8192, seed: EVAL_SEED + r, enableThinking: false }, TaggedChapterSchema);
        const byId = new Map(res.data.paragraphs.map((p) => [p.id, p]));
        let realigned = 0; let bad = '';
        for (const p of paras) {
          const got = byId.get(p.id);
          if (!got) { bad = `${p.id} missing`; break; }
          const a = alignSegments(p.text, got.segments);
          if (!a.ok) { bad = `${p.id} altered at ${a.index}`; break; }
          if (a.adjusted) realigned++;
        }
        const speechN = res.data.paragraphs.flatMap((p) => p.segments).filter((s) => s.type === 'speech').length;
        const forms = res.data.paragraphs.flatMap((p) => p.segments).filter((s) => s.address_form && !/^(unknown|none|null|)$/i.test(s.address_form)).map((s) => `${s.speaker}→${s.addressee}:${s.address_form}`);
        if (!bad) ok++;
        console.log(`[${basename(f)} r${r}] ${bad ? 'FAIL ' + bad : 'ok'} ${((Date.now() - t0) / 1000).toFixed(1)}s realigned=${realigned}/${paras.length} speech=${speechN} forms=${forms.join(' ')} tokens=${res.usage.prompt_tokens}+${res.usage.completion_tokens}`);
      } catch (e) {
        console.log(`[${basename(f)} r${r}] FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s ${(e as Error).message.slice(0, 160)}`);
      }
    }));
  }
  console.log(`${model}: ${ok}/${total} chapter-attempts passed the exactness check`);
}
main();

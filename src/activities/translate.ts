import { heartbeat } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { basename, extname } from 'node:path';
import { MODELS, EVAL_SEED } from '../config';
import { chatJson } from '../llm';
import { TranslationSchema, type Usage } from '../schemas';
import { formatParagraphs, splitParagraphs } from '../text';
import { readText, runDir, writeAtomic, writeJsonAtomic } from './io';

export interface TranslateChapterInput {
  runId: string;
  chapterPath: string;
  /** Path to a frozen glossary JSON (milestone 2+). Omitted in milestone 1. */
  glossaryPath?: string;
}

export interface TranslateChapterOutput {
  chapterName: string;
  paragraphCount: number;
  /** run-data path of {paragraphs:[{id,text}]} */
  translationPath: string;
  /** run-data path of a readable English text file */
  englishPath: string;
  usage: Usage;
}

// Stable brief: goes first in the system prompt for prefix caching. Do not interpolate per-chapter data here.
const TRANSLATOR_BRIEF = `You are a literary translator rendering a Chinese web novel into fluent, natural English.

Rules:
- Translate every paragraph. Output exactly one entry per source paragraph, with the same id, in the same order.
- Do not merge, split, drop, or add paragraphs. Do not leave any Chinese characters in the output.
- Keep names, titles, and invented terms consistent within the chapter. Follow the glossary exactly when one is given.
- Preserve dialogue as dialogue, keep tone and register, and prefer idiomatic English over literal word order.
- Return JSON only, matching the schema.`;

function chapterNameOf(path: string): string {
  return basename(path, extname(path));
}

/** Run fn while heartbeating every 5s so the workflow can detect a dead worker (heartbeatTimeout 15s). */
async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => heartbeat(), 5_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export async function translateChapter(input: TranslateChapterInput): Promise<TranslateChapterOutput> {
  return withHeartbeat(async () => {
    const chapterName = chapterNameOf(input.chapterPath);
    const source = await readText(input.chapterPath);
    const paragraphs = splitParagraphs(source);
    if (paragraphs.length === 0) {
      throw ApplicationFailure.create({ type: 'EmptyChapter', message: `no paragraphs in ${input.chapterPath}`, nonRetryable: true });
    }

    const glossaryBlock = input.glossaryPath ? await readText(input.glossaryPath) : '';
    const system = glossaryBlock ? `${TRANSLATOR_BRIEF}\n\nGLOSSARY (frozen, sorted):\n${glossaryBlock}` : TRANSLATOR_BRIEF;
    const user = `Translate the following ${paragraphs.length} paragraphs (ids ${paragraphs[0].id}..${paragraphs[paragraphs.length - 1].id}).\n\n${formatParagraphs(paragraphs)}`;

    // Output budget: Chinese->English roughly 1 token per char of source; give headroom for JSON overhead.
    const maxTokens = Math.max(1024, Math.ceil(source.length * 1.5) + 512);

    const res = await chatJson(
      { model: MODELS.translator, system, user, schemaName: 'translation', maxTokens, seed: EVAL_SEED, enableThinking: false },
      TranslationSchema,
    );

    // Paragraph IDs must round-trip exactly. Any mismatch is a retryable model error.
    const expected = paragraphs.map((p) => p.id);
    const got = res.data.paragraphs.map((p) => p.id);
    const missing = expected.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !expected.includes(id));
    const dupes = got.filter((id, i) => got.indexOf(id) !== i);
    if (missing.length || extra.length || dupes.length) {
      throw ApplicationFailure.create({
        type: 'ParagraphIdMismatch',
        message: `ids mismatch: missing=[${missing}] extra=[${extra}] dupes=[${dupes}]`,
        nonRetryable: false,
      });
    }
    // Normalize order to the source order.
    const byId = new Map(res.data.paragraphs.map((p) => [p.id, p.text]));
    const ordered = expected.map((id) => ({ id, text: byId.get(id)! }));

    const dir = runDir(input.runId, 'chapters', chapterName);
    const translationPath = `${dir}/translation.json`;
    const englishPath = `${dir}/translation.en.txt`;
    await writeJsonAtomic(translationPath, { chapter: chapterName, source: input.chapterPath, paragraphs: ordered });
    await writeAtomic(englishPath, ordered.map((p) => p.text).join('\n\n') + '\n');
    await writeJsonAtomic(`${dir}/translate.usage.json`, res.usage);

    return { chapterName, paragraphCount: ordered.length, translationPath, englishPath, usage: res.usage };
  });
}

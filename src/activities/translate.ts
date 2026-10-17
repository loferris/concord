import { ApplicationFailure } from '@temporalio/common';
import { MODELS } from '../config';
import { chatJson, chatText } from '../llm';
import { baselinePrompt, formatGlossaryForTranslator, formatPolicies, renderTaggedParagraph, STYLE_BRIEF, translatorPrompt } from '../prompts';
import { TranslationSchema, type Glossary, type Policies, type TaggedChapter, type Usage } from '../schemas';
import { formatParagraphs, splitParagraphs } from '../text';
import { readText, recordUsage, runDir, writeAtomic, writeJsonAtomic } from './io';
import { attemptSeed, chapterNameOf, withHeartbeat } from './common';

export interface TranslateChapterInput {
  runId: string;
  chapterPath: string;
  /** tagged.json from the tagger; plain paragraphs are used when absent (milestone-1 path). */
  taggedPath?: string;
  glossaryPath?: string;
  policiesPath?: string;
}

export interface TranslateChapterOutput {
  chapterName: string;
  paragraphCount: number;
  /** run-data path of {paragraphs:[{id,text}], new_terms} */
  translationPath: string;
  /** run-data path of a readable English text file */
  englishPath: string;
  newTermCount: number;
  usage: Usage;
}

export async function translateChapter(input: TranslateChapterInput): Promise<TranslateChapterOutput> {
  return withHeartbeat(async () => {
    const chapterName = chapterNameOf(input.chapterPath);
    const source = await readText(input.chapterPath);
    const paragraphs = splitParagraphs(source);
    if (paragraphs.length === 0) {
      throw ApplicationFailure.create({ type: 'EmptyChapter', message: `no paragraphs in ${input.chapterPath}`, nonRetryable: true });
    }

    // Stable prefix: brief + policies + the FULL glossary sorted by source, byte-identical across chapters.
    const policies = input.policiesPath ? formatPolicies(JSON.parse(await readText(input.policiesPath)) as Policies) : '(none)';
    const glossary = input.glossaryPath ? formatGlossaryForTranslator((JSON.parse(await readText(input.glossaryPath)) as Glossary).entries) : '(none)';
    let chapterBlock: string;
    if (input.taggedPath) {
      const tagged = JSON.parse(await readText(input.taggedPath)) as TaggedChapter;
      chapterBlock = tagged.paragraphs.map((p) => `[${p.id}]\n${renderTaggedParagraph(p)}`).join('\n\n');
    } else {
      chapterBlock = formatParagraphs(paragraphs);
    }
    const prompt = translatorPrompt(STYLE_BRIEF, policies, glossary, chapterBlock);
    const maxTokens = Math.max(2048, Math.ceil(source.length * 1.5) + 512);
    const res = await chatJson({ model: MODELS.translator, ...prompt, schemaName: 'translation', maxTokens, seed: attemptSeed(), enableThinking: false }, TranslationSchema);

    // Paragraph IDs must round-trip exactly. Any mismatch is a retryable model error.
    const expected = paragraphs.map((p) => p.id);
    const got = res.data.paragraphs.map((p) => p.id);
    const missing = expected.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !expected.includes(id));
    const dupes = got.filter((id, i) => got.indexOf(id) !== i);
    if (missing.length || extra.length || dupes.length) {
      throw ApplicationFailure.create({ type: 'ParagraphIdMismatch', message: `ids mismatch: missing=[${missing}] extra=[${extra}] dupes=[${dupes}]`, nonRetryable: false });
    }
    // No tags may leak into the English.
    const leaked = res.data.paragraphs.filter((p) => /<\/?(speech|narration|thought|text_message)\b/.test(p.text)).map((p) => p.id);
    if (leaked.length) throw ApplicationFailure.create({ type: 'TagsLeaked', message: `tags in output: ${leaked.join(', ')}`, nonRetryable: false });

    const byId = new Map(res.data.paragraphs.map((p) => [p.id, p.text.trim()]));
    const ordered = expected.map((id) => ({ id, text: byId.get(id)! }));

    const dir = runDir(input.runId, 'chapters', chapterName);
    const translationPath = `${dir}/translation.json`;
    const englishPath = `${dir}/translation.en.txt`;
    await writeJsonAtomic(translationPath, { chapter: chapterName, source: input.chapterPath, glossary: input.glossaryPath ?? null, paragraphs: ordered, new_terms: res.data.new_terms });
    await writeAtomic(englishPath, ordered.map((p) => p.text).join('\n\n') + '\n');
    await recordUsage(input.runId, 'translator', chapterName, res.usage);
    return { chapterName, paragraphCount: ordered.length, translationPath, englishPath, newTermCount: res.data.new_terms.length, usage: res.usage };
  });
}

export interface BaselineOutput {
  chapterName: string;
  englishPath: string;
  usage: Usage;
}

/** Ablation baseline: one plain prompt per chapter, same writer model, no glossary, no policies, no IDs. */
export async function translateBaseline(input: { runId: string; chapterPath: string }): Promise<BaselineOutput> {
  return withHeartbeat(async () => {
    const chapterName = chapterNameOf(input.chapterPath);
    const source = await readText(input.chapterPath);
    const res = await chatText({ model: MODELS.translator, ...baselinePrompt(source), schemaName: 'baseline', maxTokens: Math.max(2048, Math.ceil(source.length * 1.5) + 512), seed: attemptSeed(), enableThinking: false });
    const englishPath = runDir(input.runId, 'baseline', `${chapterName}.en.txt`);
    await writeAtomic(englishPath, res.content.trim() + '\n');
    await recordUsage(input.runId, 'baseline', chapterName, res.usage);
    return { chapterName, englishPath, usage: res.usage };
  });
}

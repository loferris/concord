import { MODELS } from '../config';
import { chatJson } from '../llm';
import { formatGlossaryForTranslator, renderTaggedParagraph, reviewerPrompt, STYLE_BRIEF } from '../prompts';
import { ReviewSchema, type Glossary, type Review, type TaggedChapter, type Usage } from '../schemas';
import { formatLint, lintParagraphs, type LintViolation } from '../checks';
import { splitParagraphs } from '../text';
import { readText, recordUsage, runDir, writeJsonAtomic } from './io';
import { attemptSeed, chapterNameOf, withHeartbeat } from './common';

export interface ReviewChapterInput {
  runId: string;
  chapterPath: string;
  translationPath: string;
  taggedPath?: string;
  glossaryPath?: string;
  round: number;
}
export interface ReviewChapterOutput {
  reviewPath: string;
  verdict: Review['verdict'];
  issues: { critical: number; major: number; minor: number };
  lint: { banned: number; missing: number; cjk: number };
  termDisputes: number;
  /** Issues the translator must act on in a revision (critical + major + lint), formatted for prompt #7's revision block. */
  revisionIssues: string;
  usage: Usage;
}

/** Code lint first (term violations are facts), then GLM reviews quality with thinking on. */
export async function reviewChapter(input: ReviewChapterInput): Promise<ReviewChapterOutput> {
  return withHeartbeat(async () => {
    const chapterName = chapterNameOf(input.chapterPath);
    const zh = splitParagraphs(await readText(input.chapterPath));
    const t = JSON.parse(await readText(input.translationPath)) as { paragraphs: { id: string; text: string }[] };
    const byId = new Map(t.paragraphs.map((p) => [p.id, p.text]));
    const glossary = input.glossaryPath ? (JSON.parse(await readText(input.glossaryPath)) as Glossary).entries : [];
    const lint: LintViolation[] = lintParagraphs(glossary, zh.map((p) => ({ id: p.id, zh: p.text, en: byId.get(p.id) ?? '' })));

    const tagged = input.taggedPath ? (JSON.parse(await readText(input.taggedPath)) as TaggedChapter) : null;
    const sourceBlock = tagged ? tagged.paragraphs.map((p) => `[${p.id}]\n${renderTaggedParagraph(p)}`).join('\n\n') : zh.map((p) => `[${p.id}]\n${p.text}`).join('\n\n');
    const prompt = reviewerPrompt(STYLE_BRIEF, glossary.length ? formatGlossaryForTranslator(glossary) : '(none)', formatLint(lint), sourceBlock, JSON.stringify(t.paragraphs));
    const res = await chatJson({ model: MODELS.reviewer, ...prompt, schemaName: 'review', maxTokens: 16384, seed: attemptSeed(), enableThinking: true }, ReviewSchema);

    const review = res.data;
    const count = (sev: string) => review.issues.filter((i) => i.severity === sev).length;
    const actionable = review.issues.filter((i) => i.severity !== 'minor');
    const revisionIssues = [
      ...lint.map((v) => `${v.paragraphId}: [glossary] ${v.detail}`),
      ...actionable.map((i) => `${i.paragraph_id}: [${i.severity}/${i.category}] "${i.quote}" → ${i.suggestion}`),
    ].join('\n');
    const reviewPath = runDir(input.runId, 'chapters', chapterName, `review.r${input.round}.json`);
    await writeJsonAtomic(reviewPath, { round: input.round, lint, ...review, usage: res.usage });
    await recordUsage(input.runId, 'reviewer', `${chapterName}.r${input.round}`, res.usage);
    return {
      reviewPath,
      verdict: review.verdict,
      issues: { critical: count('critical'), major: count('major'), minor: count('minor') },
      lint: { banned: lint.filter((v) => v.kind === 'banned_variant').length, missing: lint.filter((v) => v.kind === 'missing_rendering').length, cjk: lint.filter((v) => v.kind === 'leftover_cjk').length },
      termDisputes: review.term_disputes.length,
      revisionIssues,
      usage: res.usage,
    };
  });
}

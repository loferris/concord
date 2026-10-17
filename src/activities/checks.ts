import { leftoverCJK, nestedTermViolations, renderingCollisions, summarize, termDistribution, type ChapterText, type CheckSummary } from '../checks';
import type { Glossary } from '../schemas';
import { splitParagraphs } from '../text';
import { readText, runDir, writeJsonAtomic } from './io';

export interface RunChecksInput {
  runId: string;
  glossaryPath: string;
  /** 'full' = translation.json files with paragraph ids; 'baseline' = plain English text files */
  label: 'full' | 'baseline';
  chapters: { name: string; sourcePath: string; englishPath: string; translationPath?: string }[];
}
export interface RunChecksOutput {
  checksPath: string;
  summary: CheckSummary;
}

export async function runChecks(input: RunChecksInput): Promise<RunChecksOutput> {
  const glossary = JSON.parse(await readText(input.glossaryPath)) as Glossary;
  const chapters: ChapterText[] = [];
  for (const ch of input.chapters) {
    const en = await readText(ch.englishPath);
    if (ch.translationPath) {
      const zh = splitParagraphs(await readText(ch.sourcePath));
      const t = JSON.parse(await readText(ch.translationPath)) as { paragraphs: { id: string; text: string }[] };
      const byId = new Map(t.paragraphs.map((p) => [p.id, p.text]));
      chapters.push({ name: ch.name, en, paragraphs: zh.map((p) => ({ id: p.id, zh: p.text, en: byId.get(p.id) ?? '' })) });
    } else chapters.push({ name: ch.name, en });
  }
  const stats = termDistribution(glossary.entries, chapters);
  const leaks = leftoverCJK(chapters);
  const collisions = renderingCollisions(glossary.entries);
  const nested = nestedTermViolations(glossary.entries);
  const summary = summarize(stats, leaks, collisions.length, nested.length);
  const checksPath = runDir(input.runId, 'checks', `${input.label}.json`);
  await writeJsonAtomic(checksPath, { label: input.label, glossary: input.glossaryPath, summary, stats, leaks, collisions, nested });
  return { checksPath, summary };
}

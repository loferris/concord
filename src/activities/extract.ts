import { MODELS } from '../config';
import { chatJson } from '../llm';
import { boundaryEntropyCandidates, formatCandidates, verifyExtraction } from '../extract';
import { extractorPrompt } from '../prompts';
import { ExtractionSchema, type Usage } from '../schemas';
import { splitParagraphs } from '../text';
import { readText, recordUsage, runDir, writeJsonAtomic } from './io';
import { attemptSeed, chapterNameOf, withHeartbeat } from './common';

export interface ExtractTermsInput {
  runId: string;
  chapterPaths: string[];
}
export interface ExtractTermsOutput {
  extractionPath: string;
  candidatesPath: string;
  candidateCount: number;
  itemCount: number;
  rejectedCount: number;
  usage: Usage;
}

/** Whole book in one Lightning call, with boundary-entropy candidates to confirm or reject. */
export async function extractTerms(input: ExtractTermsInput): Promise<ExtractTermsOutput> {
  return withHeartbeat(async () => {
    const all: { id: string; text: string }[] = [];
    const bookBlocks: string[] = [];
    for (const path of input.chapterPaths) {
      const ch = chapterNameOf(path);
      const paras = splitParagraphs(await readText(path));
      for (const p of paras) {
        all.push({ id: `${ch}.${p.id}`, text: p.text });
        bookBlocks.push(`[${ch}.${p.id}]\n${p.text}`);
      }
    }
    const candidates = boundaryEntropyCandidates(all, { top: 40 });
    const prompt = extractorPrompt(formatCandidates(candidates), bookBlocks.join('\n\n'));
    const res = await chatJson(
      { model: MODELS.extractor, ...prompt, schemaName: 'extraction', maxTokens: 8192, seed: attemptSeed(), enableThinking: false },
      ExtractionSchema,
    );
    // Code check: every item must occur verbatim in the book; terms/phrases must recur; ids are recomputed.
    const { kept, dropped } = verifyExtraction(res.data.items, all);
    if (dropped.length) console.log(`[extract] dropped ${dropped.length}/${res.data.items.length} items: ${dropped.map((d) => `${d.source} (${d.why})`).join('; ')}`);
    const extraction = { items: kept, rejected_candidates: res.data.rejected_candidates, dropped_by_code: dropped };
    const dir = runDir(input.runId, 'glossary');
    const extractionPath = `${dir}/extraction.json`;
    const candidatesPath = `${dir}/candidates.json`;
    await writeJsonAtomic(candidatesPath, candidates);
    await writeJsonAtomic(extractionPath, extraction);
    await recordUsage(input.runId, 'extractor', 'book', res.usage);
    return { extractionPath, candidatesPath, candidateCount: candidates.length, itemCount: extraction.items.length, rejectedCount: extraction.rejected_candidates.length + dropped.length, usage: res.usage };
  });
}

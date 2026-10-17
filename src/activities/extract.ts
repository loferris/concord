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
  /** Incremental mode (single chapter): keep single-occurrence items the extractor marks as needing a fixed
   *  rendering or that are already glossary sources/aliases; write under glossary/incremental/<chapter>/. */
  incremental?: { knownSources: string[]; chapterName: string };
}
export interface CaptureRecapture {
  runA: number;
  runB: number;
  both: number;
  union: number;
  /** Chapman estimator of the true number of terms: (nA+1)(nB+1)/(nBoth+1) - 1 */
  estimatedTotal: number;
  /** union / estimatedTotal */
  estimatedRecall: number;
  onlyA: string[];
  onlyB: string[];
}
export interface ExtractTermsOutput {
  extractionPath: string;
  candidatesPath: string;
  candidateCount: number;
  itemCount: number;
  rejectedCount: number;
  captureRecapture: CaptureRecapture;
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
    // Two independent passes (different seeds), sequential: Lightning on Crusoe 429s on concurrent requests.
    // The union is the extraction; the overlap gives a capture-recapture estimate of how many terms exist
    // and therefore of our recall.
    const call = (offset: number) => chatJson({ model: MODELS.extractor, ...prompt, schemaName: 'extraction', maxTokens: 8192, seed: attemptSeed() + offset, enableThinking: false }, ExtractionSchema);
    const resA = await call(0);
    const resB = await call(5000);
    const known = new Set(input.incremental?.knownSources ?? []);
    const keepSingle = input.incremental ? (it: { source: string; needs_fixed_rendering: boolean }) => it.needs_fixed_rendering || known.has(it.source) : undefined;
    const vA = verifyExtraction(resA.data.items, all, { keepSingle });
    const vB = verifyExtraction(resB.data.items, all, { keepSingle });
    const dropped = [...vA.dropped, ...vB.dropped];
    if (dropped.length) console.log(`[extract] dropped ${dropped.length}/${resA.data.items.length + resB.data.items.length} items: ${dropped.map((d) => `${d.source} (${d.why})`).join('; ')}`);
    const union = new Map<string, (typeof vA.kept)[number]>();
    for (const it of [...vA.kept, ...vB.kept]) {
      const cur = union.get(it.source);
      if (cur) {
        cur.needs_fixed_rendering = cur.needs_fixed_rendering || it.needs_fixed_rendering;
        cur.paragraph_ids = Array.from(new Set([...cur.paragraph_ids, ...it.paragraph_ids])).sort();
      } else union.set(it.source, { ...it });
    }
    const setA = new Set(vA.kept.map((i) => i.source));
    const setB = new Set(vB.kept.map((i) => i.source));
    const both = [...setA].filter((s) => setB.has(s)).length;
    const estimatedTotal = ((setA.size + 1) * (setB.size + 1)) / (both + 1) - 1;
    const captureRecapture: CaptureRecapture = {
      runA: setA.size,
      runB: setB.size,
      both,
      union: union.size,
      estimatedTotal: Math.round(estimatedTotal * 10) / 10,
      estimatedRecall: Math.min(1, Math.round((union.size / estimatedTotal) * 1000) / 1000),
      onlyA: [...setA].filter((s) => !setB.has(s)),
      onlyB: [...setB].filter((s) => !setA.has(s)),
    };
    console.log(`[extract] capture-recapture: A=${setA.size} B=${setB.size} both=${both} union=${union.size} est.total=${captureRecapture.estimatedTotal} est.recall=${captureRecapture.estimatedRecall}`);
    const res = { usage: { ...resA.usage, prompt_tokens: resA.usage.prompt_tokens + resB.usage.prompt_tokens, completion_tokens: resA.usage.completion_tokens + resB.usage.completion_tokens } };
    const extraction = { items: Array.from(union.values()), rejected_candidates: [...resA.data.rejected_candidates, ...resB.data.rejected_candidates], dropped_by_code: dropped, capture_recapture: captureRecapture };
    await recordUsage(input.runId, 'extractor', 'book-A', resA.usage);
    const dir = input.incremental ? runDir(input.runId, 'glossary', 'incremental', input.incremental.chapterName) : runDir(input.runId, 'glossary');
    const extractionPath = `${dir}/extraction.json`;
    const candidatesPath = `${dir}/candidates.json`;
    await writeJsonAtomic(candidatesPath, candidates);
    await writeJsonAtomic(extractionPath, extraction);
    await recordUsage(input.runId, 'extractor', 'book-B', resB.usage);
    return { extractionPath, candidatesPath, candidateCount: candidates.length, itemCount: extraction.items.length, rejectedCount: extraction.rejected_candidates.length + dropped.length, captureRecapture, usage: res.usage };
  });
}

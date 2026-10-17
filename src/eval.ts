// Eval-only code. This is the ONLY module allowed to read ref/english-reference.md (the answer key).
import { readFile } from 'node:fs/promises';
import { leftoverCJK, summarize, termDistribution, type ChapterText, type CheckSummary, type GlossaryLike, type TermStat } from './checks';
import { normRendering } from './normalize';
import type { Glossary, GlossaryEntry } from './schemas';
import { splitParagraphs } from './text';

export const REFERENCE_PATH = 'ref/english-reference.md';

export interface ColumnResult {
  summary: CheckSummary;
  stats: TermStat[];
}

/** Compute the check summary in-process for a set of English chapters against a glossary. */
export function checkColumn(glossary: GlossaryLike[], chapters: ChapterText[]): ColumnResult {
  const stats = termDistribution(glossary, chapters);
  return { summary: summarize(stats, leftoverCJK(chapters), 0, 0), stats };
}

export async function loadFullChapters(runDir: string, chapterNames: string[], sourcePaths: string[], draft: boolean): Promise<ChapterText[]> {
  const out: ChapterText[] = [];
  for (let i = 0; i < chapterNames.length; i++) {
    const dir = `${runDir}/chapters/${chapterNames[i]}`;
    let file = `${dir}/translation.json`;
    if (draft) {
      // First draft is kept as translation.r0.json when a revision happened; otherwise the final is the draft.
      try {
        await readFile(`${dir}/translation.r0.json`);
        file = `${dir}/translation.r0.json`;
      } catch {
        /* no revision happened */
      }
    }
    const t = JSON.parse(await readFile(file, 'utf8')) as { paragraphs: { id: string; text: string }[] };
    const zh = splitParagraphs(await readFile(sourcePaths[i], 'utf8'));
    const byId = new Map(t.paragraphs.map((p) => [p.id, p.text]));
    out.push({ name: chapterNames[i], en: t.paragraphs.map((p) => p.text).join('\n\n'), paragraphs: zh.map((p) => ({ id: p.id, zh: p.text, en: byId.get(p.id) ?? '' })) });
  }
  return out;
}

export async function loadBaselineChapters(runDir: string, chapterNames: string[]): Promise<ChapterText[]> {
  const out: ChapterText[] = [];
  for (const n of chapterNames) out.push({ name: n, en: await readFile(`${runDir}/baseline/${n}.en.txt`, 'utf8') });
  return out;
}

// ---- (a) Glossary agreement with the reference table ------------------------------------------------
export interface RefRow {
  sources: string[];
  alternates: string[][]; // per source: list of acceptable renderings
  notes: string;
}

/** Parse the reference glossary table. "A / B" sources with "a / b" renderings map positionally. */
export function parseReferenceGlossary(md: string): RefRow[] {
  const section = md.split(/^## /m).find((s) => s.startsWith('Glossary')) ?? '';
  const rows: RefRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-+/.test(line) || /^\|\s*Source/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const sources = cells[0].split('/').map((s) => s.trim()).filter(Boolean);
    const renderingCell = cells[1];
    // Alternates: quoted strings and "/"-separated parts; drop parenthetical commentary but keep quoted alternates inside it.
    const quoted = Array.from(renderingCell.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    const stripped = renderingCell.replace(/\([^)]*\)/g, ' ').replace(/"/g, ' ');
    const parts = stripped.split('/').map((s) => s.trim()).filter(Boolean);
    if (sources.length > 1 && parts.length === sources.length) {
      rows.push({ sources, alternates: parts.map((p) => [p]), notes: cells[2] ?? '' });
    } else {
      const alts = Array.from(new Set([...parts, ...quoted]));
      rows.push({ sources, alternates: sources.map(() => alts), notes: cells[2] ?? '' });
    }
  }
  return rows;
}

export interface AgreementResult {
  compared: number;
  matches: number;
  mismatches: { source: string; ours: string; reference: string[]; decided_by: string }[];
  notInGlossary: string[];
}

/** Our rendering (entry or alias) vs the reference alternates, normalized. */
export function glossaryAgreement(entries: GlossaryEntry[], ref: RefRow[]): AgreementResult {
  const ours = new Map<string, { rendering: string; decided_by: string }>();
  for (const e of entries) {
    ours.set(e.source, { rendering: e.rendering, decided_by: e.decided_by });
    for (const a of e.alias_renderings) if (!ours.has(a.source)) ours.set(a.source, { rendering: a.rendering, decided_by: `${e.decided_by} (alias of ${e.source})` });
  }
  const res: AgreementResult = { compared: 0, matches: 0, mismatches: [], notInGlossary: [] };
  for (const row of ref) {
    row.sources.forEach((src, i) => {
      // 观澜数据 in the reference vs 观澜 in ours: compare on the longest glossary source contained in the ref source.
      const key = ours.has(src) ? src : Array.from(ours.keys()).filter((k) => src.includes(k)).sort((a, b) => b.length - a.length)[0];
      if (!key) {
        res.notInGlossary.push(src);
        return;
      }
      const o = ours.get(key)!;
      res.compared++;
      const alts = row.alternates[i];
      const hit = alts.some((a) => normRendering(a) === normRendering(o.rendering)) || (key !== src && alts.some((a) => normRendering(a).includes(normRendering(o.rendering))));
      if (hit) res.matches++;
      else res.mismatches.push({ source: src, ours: o.rendering, reference: alts, decided_by: o.decided_by });
    });
  }
  return res;
}

// ---- (b) Fact ledger ----------------------------------------------------------------------------
export const FACTS: { name: string; re: RegExp }[] = [
  { name: '3,412 accounts', re: /\b3,?412\b|three thousand,? four hundred(?: and)? twelve/gi },
  { name: '1–2 a.m. window', re: /\b(?:1|one)(?:\s*(?:a\.?m\.?|o.clock))?\s*(?:to|and|–|-|—)\s*(?:2|two)\s*(?:a\.?m\.?|o.clock|in the morning)/gi },
  { name: '72 hours', re: /\b(?:72|seventy[- ]two)\s*hours?\b/gi },
  { name: '200 million users', re: /\b(?:200|two hundred)\s*million\b/gi },
  { name: 'nine years', re: /\bnine years\b/gi },
  { name: 'three years', re: /\bthree years\b/gi },
  { name: 'two months', re: /\btwo months\b/gi },
  { name: '~300 accounts', re: /\b(?:300|three hundred)\b(?![,\d])/gi },
  { name: '11 p.m.', re: /\b(?:11|eleven)\s*(?:p\.?m\.?|o.clock at night|at night)|\beleven at night\b/gi },
  { name: '8 a.m.', re: /\b(?:8|eight)\s*(?:a\.?m\.?|o.clock|in the morning)|\bat eight\b/gi },
];

export function factCounts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FACTS) out[f.name] = (text.match(f.re) ?? []).length;
  return out;
}

export async function referenceEnglish(): Promise<string> {
  const md = await readFile(REFERENCE_PATH, 'utf8');
  return md.split(/^## Chapter 1/m).slice(1).join('\n');
}
export async function referenceGlossary(): Promise<RefRow[]> {
  return parseReferenceGlossary(await readFile(REFERENCE_PATH, 'utf8'));
}
export type { Glossary };

// ---- Shared ablation computation (CLI table and HTML report) --------------------------------------
import { readdir } from 'node:fs/promises';
import { PRICING } from './config';

export interface UsageRow {
  role: string;
  label: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number | null;
}
export async function readUsage(runDir: string): Promise<UsageRow[]> {
  try {
    return (await readFile(`${runDir}/usage.jsonl`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as UsageRow);
  } catch {
    return [];
  }
}
export interface Cost {
  usd: number;
  prompt: number;
  cached: number;
  completion: number;
  calls: number;
}
export function cost(rows: UsageRow[]): Cost {
  let usd = 0, prompt = 0, cached = 0, completion = 0;
  for (const r of rows) {
    const p = PRICING[r.model.replace(/^fake:/, '')] ?? { prompt: 0, completion: 0, cached: 0 };
    const c = r.cached_tokens ?? 0;
    usd += ((r.prompt_tokens - c) * p.prompt + c * p.cached + r.completion_tokens * p.completion) / 1e6;
    prompt += r.prompt_tokens;
    cached += c;
    completion += r.completion_tokens;
  }
  return { usd, prompt, cached, completion, calls: rows.length };
}

export interface Ablation {
  runId: string;
  glossaryRunId: string;
  glossaryPath: string;
  glossary: Glossary;
  chapterNames: string[];
  base: ColumnResult;
  draft: ColumnResult;
  final: ColumnResult;
  costs: { baseline: Cost; translator: Cost; reviewer: Cost; reviser: Cost; glossary: Cost };
}
export async function computeAblation(runDataDir: string, runId: string, glossaryRunId?: string): Promise<Ablation> {
  const dir = `${runDataDir}/${runId}`;
  const chapterNames = (await readdir(`${dir}/chapters`)).sort();
  const first = JSON.parse(await readFile(`${dir}/chapters/${chapterNames[0]}/translation.json`, 'utf8')) as { source: string; glossary: string | null };
  const sourcePaths = chapterNames.map((n) => first.source.replace(/[^/]+$/, `${n}.txt`));
  const glossaryPath = first.glossary!;
  const glossary = JSON.parse(await readFile(glossaryPath, 'utf8')) as Glossary;
  const gRun = glossaryRunId ?? glossaryPath.split('/')[1];
  const base = checkColumn(glossary.entries, await loadBaselineChapters(dir, chapterNames));
  const draft = checkColumn(glossary.entries, await loadFullChapters(dir, chapterNames, sourcePaths, true));
  const final = checkColumn(glossary.entries, await loadFullChapters(dir, chapterNames, sourcePaths, false));
  const usage = await readUsage(dir);
  const glossaryUsage = gRun !== runId ? await readUsage(`${runDataDir}/${gRun}`) : usage;
  const notTranslation = (r: UsageRow) => !['translator', 'baseline', 'reviewer', 'reviser'].includes(r.role);
  return {
    runId,
    glossaryRunId: gRun,
    glossaryPath,
    glossary,
    chapterNames,
    base,
    draft,
    final,
    costs: {
      baseline: cost(usage.filter((r) => r.role === 'baseline')),
      translator: cost(usage.filter((r) => r.role === 'translator')),
      reviewer: cost(usage.filter((r) => r.role === 'reviewer')),
      reviser: cost(usage.filter((r) => r.role === 'reviser')),
      glossary: cost(glossaryUsage.filter(notTranslation)),
    },
  };
}

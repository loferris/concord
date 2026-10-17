// Pure checks shared by the post-pass and the eval. No I/O.
import { normRendering } from './normalize';

export interface GlossaryLike {
  source: string;
  rendering: string;
  alias_renderings: { source: string; rendering: string }[];
  banned: string[];
}

export interface NestedViolation {
  source: string;
  within: string;
  rendering: string;
  requiredRendering: string;
}

/** If A's source contains B's source, A's rendering must contain B's rendering (after normalization). */
export function nestedTermViolations(entries: GlossaryLike[]): NestedViolation[] {
  const out: NestedViolation[] = [];
  for (const a of entries) {
    for (const b of entries) {
      if (a === b || a.source === b.source || !a.source.includes(b.source)) continue;
      if (!normRendering(a.rendering).includes(normRendering(b.rendering))) {
        out.push({ source: a.source, within: b.source, rendering: a.rendering, requiredRendering: b.rendering });
      }
    }
  }
  return out;
}

// ---- Term rendering distribution, banned variants, leftover CJK ------------------------------------
export interface ChapterText {
  name: string;
  /** English text (whole chapter) */
  en: string;
  /** Source paragraphs and aligned English paragraphs when available (full system only). */
  paragraphs?: { id: string; zh: string; en: string }[];
}

export interface TermStat {
  source: string;
  /** Occurrences of the source (and aliases) in the Chinese */
  sourceHits: number;
  /** Occurrences of the chosen rendering (and alias renderings) in the English */
  renderingHits: number;
  /** Occurrences of each banned variant in the English */
  bannedHits: { variant: string; count: number }[];
  /** Distinct renderings seen among {rendering, aliases, banned} */
  variantsUsed: string[];
  /** Per-paragraph coverage when aligned paragraphs exist: paragraphs with the source whose English has a rendering */
  coverage?: { covered: number; total: number };
}

function wordRe(needle: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'gi');
}
/**
 * Count each variant as a whole word, longest first, masking matches so a short variant ("Shen") is not
 * also counted inside a longer one ("Shen Che", "Shen Jie").
 */
function countVariants(hay: string, variants: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  let work = hay;
  for (const v of [...new Set(variants.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    let n = 0;
    work = work.replace(wordRe(v), () => {
      n++;
      return '\u0000';
    });
    counts.set(v, (counts.get(v) ?? 0) + n);
  }
  return counts;
}
function countOccurrences(hay: string, needle: string): number {
  return needle ? (hay.match(wordRe(needle)) ?? []).length : 0;
}
function countCJK(hay: string, needle: string): number {
  return needle ? hay.split(needle).length - 1 : 0;
}

export function termDistribution(entries: GlossaryLike[], chapters: ChapterText[]): TermStat[] {
  return entries.map((e) => {
    const sources = [e.source, ...e.alias_renderings.map((a) => a.source)];
    const renderings = Array.from(new Set([e.rendering, ...e.alias_renderings.map((a) => a.rendering)].filter(Boolean)));
    let sourceHits = 0;
    let renderingHits = 0;
    const banned = new Map<string, number>();
    let covered = 0;
    let total = 0;
    let anyAligned = false;
    const bannedList = e.banned.filter((b) => !renderings.some((r) => r.toLowerCase() === b.toLowerCase()));
    for (const ch of chapters) {
      const counts = countVariants(ch.en, [...renderings, ...bannedList]);
      for (const r of renderings) renderingHits += counts.get(r) ?? 0;
      for (const b of bannedList) banned.set(b, (banned.get(b) ?? 0) + (counts.get(b) ?? 0));
      if (ch.paragraphs) {
        anyAligned = true;
        for (const p of ch.paragraphs) {
          const n = sources.reduce((a, s) => a + countCJK(p.zh, s), 0);
          if (!n) continue;
          sourceHits += n;
          total++;
          const c = countVariants(p.en, [...renderings, ...bannedList]);
          if (renderings.some((r) => (c.get(r) ?? 0) > 0)) covered++;
        }
      }
    }
    const bannedHits = Array.from(banned.entries()).filter(([, c]) => c > 0).map(([variant, count]) => ({ variant, count }));
    const allText = chapters.map((ch) => ch.en).join('\n');
    const used = countVariants(allText, [...renderings, ...bannedList]);
    const variantsUsed = [...renderings, ...bannedList].filter((v) => (used.get(v) ?? 0) > 0);
    return { source: e.source, sourceHits, renderingHits, bannedHits, variantsUsed, coverage: anyAligned ? { covered, total } : undefined };
  });
}

export interface CJKLeak {
  chapter: string;
  paragraphId?: string;
  snippet: string;
}
const CJK_RUN = /[㐀-䶿一-鿿]+/g;
export function leftoverCJK(chapters: ChapterText[]): CJKLeak[] {
  const out: CJKLeak[] = [];
  for (const ch of chapters) {
    if (ch.paragraphs) {
      for (const p of ch.paragraphs) for (const m of p.en.matchAll(CJK_RUN)) out.push({ chapter: ch.name, paragraphId: p.id, snippet: m[0] });
    } else {
      for (const m of ch.en.matchAll(CJK_RUN)) out.push({ chapter: ch.name, snippet: m[0] });
    }
  }
  return out;
}

export function renderingCollisions(entries: GlossaryLike[]): { rendering: string; sources: string[] }[] {
  const by = new Map<string, string[]>();
  for (const e of entries) {
    const k = normRendering(e.rendering);
    by.set(k, [...(by.get(k) ?? []), e.source]);
  }
  return Array.from(by.entries()).filter(([, s]) => s.length > 1).map(([rendering, sources]) => ({ rendering, sources }));
}

export interface CheckSummary {
  terms: number;
  /** Term consistency: rendering hits / (rendering hits + banned hits), over terms that occur at all */
  consistency: number;
  renderingHits: number;
  bannedHits: number;
  termsWithBanned: number;
  /** Mean distinct renderings per term that appears in the English */
  meanVariants: number;
  coverage?: { covered: number; total: number };
  cjkLeaks: number;
  collisions: number;
  nestedViolations: number;
}

export function summarize(stats: TermStat[], leaks: CJKLeak[], collisions: number, nested: number): CheckSummary {
  const seen = stats.filter((s) => s.renderingHits + s.bannedHits.reduce((a, b) => a + b.count, 0) > 0);
  const renderingHits = stats.reduce((a, s) => a + s.renderingHits, 0);
  const bannedHits = stats.reduce((a, s) => a + s.bannedHits.reduce((x, b) => x + b.count, 0), 0);
  const cov = stats.some((s) => s.coverage) ? stats.reduce((a, s) => ({ covered: a.covered + (s.coverage?.covered ?? 0), total: a.total + (s.coverage?.total ?? 0) }), { covered: 0, total: 0 }) : undefined;
  return {
    terms: stats.length,
    consistency: renderingHits + bannedHits ? renderingHits / (renderingHits + bannedHits) : 1,
    renderingHits,
    bannedHits,
    termsWithBanned: stats.filter((s) => s.bannedHits.length).length,
    meanVariants: seen.length ? seen.reduce((a, s) => a + s.variantsUsed.length, 0) / seen.length : 0,
    coverage: cov,
    cjkLeaks: leaks.length,
    collisions,
    nestedViolations: nested,
  };
}

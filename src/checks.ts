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

/**
 * Whole-word match. A lowercase single-word term (a common noun/verb such as "review") also matches its
 * inflections (reviews, reviewed, reviewing); proper nouns and multi-word renderings must match exactly.
 */
function wordRe(needle: string): RegExp {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inflect = /^[a-z]+$/.test(needle) ? '(?:s|es|ed|ing|d)?' : '';
  return new RegExp(`(?<![A-Za-z])${esc}${inflect}(?![A-Za-z])`, 'gi');
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


/** Every chosen rendering in the glossary (all entries), so banned-variant counting never hits legitimate text. */
function allRenderings(entries: GlossaryLike[]): string[] {
  return Array.from(new Set(entries.flatMap((e) => [e.rendering, ...e.alias_renderings.map((a) => a.rendering)]).filter(Boolean)));
}
/** Every source string in the glossary, so a short source (复核) is not counted inside a longer one (复核组). */
function allSources(entries: GlossaryLike[]): string[] {
  return Array.from(new Set(entries.flatMap((e) => [e.source, ...e.alias_renderings.map((a) => a.source)]).filter(Boolean)));
}
/** Count CJK sources longest-first with masking (same idea as countVariants, no word boundaries). */
function countSources(hay: string, sources: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  let work = hay;
  for (const v of [...new Set(sources.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const parts = work.split(v);
    counts.set(v, parts.length - 1);
    work = parts.join('\u0000');
  }
  return counts;
}

export function termDistribution(entries: GlossaryLike[], chapters: ChapterText[]): TermStat[] {
  const everyRendering = allRenderings(entries);
  const everySource = allSources(entries);
  return entries.map((e) => {
    const sources = [e.source, ...e.alias_renderings.map((a) => a.source)];
    const renderings = Array.from(new Set([e.rendering, ...e.alias_renderings.map((a) => a.rendering)].filter(Boolean)));
    let sourceHits = 0;
    let renderingHits = 0;
    const banned = new Map<string, number>();
    let covered = 0;
    let total = 0;
    let anyAligned = false;
    const bannedList = e.banned.filter((b) => !everyRendering.some((r) => r.toLowerCase() === b.toLowerCase()));
    // Mask every glossary rendering (all entries) before counting, so "audit" inside "Audit Team" is not a hit.
    const variants = [...everyRendering, ...bannedList];
    for (const ch of chapters) {
      const counts = countVariants(ch.en, variants);
      for (const r of renderings) renderingHits += counts.get(r) ?? 0;
      for (const b of bannedList) banned.set(b, (banned.get(b) ?? 0) + (counts.get(b) ?? 0));
      if (ch.paragraphs) {
        anyAligned = true;
        for (const p of ch.paragraphs) {
          const sc = countSources(p.zh, everySource);
          const n = sources.reduce((a, s) => a + (sc.get(s) ?? 0), 0);
          if (!n) continue;
          sourceHits += n;
          total++;
          const c = countVariants(p.en, variants);
          if (renderings.some((r) => (c.get(r) ?? 0) > 0)) covered++;
        }
      }
    }
    const bannedHits = Array.from(banned.entries()).filter(([, c]) => c > 0).map(([variant, count]) => ({ variant, count }));
    const allText = chapters.map((ch) => ch.en).join('\n');
    const used = countVariants(allText, variants);
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

// ---- Per-paragraph term lint (feeds the reviewer and the revision prompt) --------------------------
export interface LintViolation {
  paragraphId: string;
  kind: 'banned_variant' | 'missing_rendering' | 'leftover_cjk';
  source?: string;
  detail: string;
}
export function lintParagraphs(entries: GlossaryLike[], paragraphs: { id: string; zh: string; en: string }[]): LintViolation[] {
  const out: LintViolation[] = [];
  const everyRendering = allRenderings(entries);
  const everySource = allSources(entries);
  for (const p of paragraphs) {
    const sc = countSources(p.zh, everySource);
    for (const e of entries) {
      const renderings = [e.rendering, ...e.alias_renderings.map((a) => a.rendering)].filter(Boolean);
      const bannedList = e.banned.filter((b) => !everyRendering.some((r) => r.toLowerCase() === b.toLowerCase()));
      const c = countVariants(p.en, [...everyRendering, ...bannedList]);
      for (const b of bannedList) if ((c.get(b) ?? 0) > 0) out.push({ paragraphId: p.id, kind: 'banned_variant', source: e.source, detail: `uses banned "${b}" for ${e.source}; glossary rendering is "${e.rendering}"` });
      const inZh = [e.source, ...e.alias_renderings.map((a) => a.source)].reduce((a, s) => a + (sc.get(s) ?? 0), 0);
      if (inZh > 0 && !renderings.some((r) => (c.get(r) ?? 0) > 0)) out.push({ paragraphId: p.id, kind: 'missing_rendering', source: e.source, detail: `${e.source} occurs in the source but "${e.rendering}" (or an alias rendering) is not in the translation` });
    }
    for (const m of p.en.matchAll(CJK_RUN)) out.push({ paragraphId: p.id, kind: 'leftover_cjk', detail: `Chinese characters left in the English: ${m[0]}` });
  }
  return out;
}
export function formatLint(v: LintViolation[]): string {
  return v.length ? v.map((x) => `${x.paragraphId}: ${x.detail}`).join('\n') : 'none';
}

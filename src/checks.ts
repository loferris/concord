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
  /** Chinese source (whole chapter); used to scope banned-variant counting when paragraphs are not aligned. */
  zh?: string;
  /** Source paragraphs and aligned English paragraphs when available (full system only). */
  paragraphs?: { id: string; zh: string; en: string }[];
}

/** A banned variant that is another entry's rendering or alias rendering is ambiguous at text level. */
export interface AmbiguousBanned {
  source: string;
  variant: string;
  /** which entry legitimately renders as this variant */
  conflictsWith: string;
}
/** Banned variants that are excluded from counting because another glossary entry legitimately uses them. */
export function ambiguousBannedVariants(entries: GlossaryLike[]): AmbiguousBanned[] {
  const owners = new Map<string, string>();
  for (const e of entries) for (const r of [e.rendering, ...e.alias_renderings.map((a) => a.rendering)]) if (r && !owners.has(normRendering(r))) owners.set(normRendering(r), e.source);
  const out: AmbiguousBanned[] = [];
  for (const e of entries) for (const b of e.banned) {
    const owner = owners.get(normRendering(b));
    if (owner) out.push({ source: e.source, variant: b, conflictsWith: owner });
  }
  return out;
}
function countableBanned(e: GlossaryLike, entries: GlossaryLike[]): string[] {
  const ambiguous = new Set(ambiguousBannedVariants(entries).filter((a) => a.source === e.source).map((a) => normRendering(a.variant)));
  return e.banned.filter((b) => !ambiguous.has(normRendering(b)));
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

/** Does the term (any of its source strings) occur in this chapter's Chinese? Unknown source text counts as yes. */
function termOccursIn(ch: ChapterText, sources: string[]): boolean {
  const zh = ch.zh ?? (ch.paragraphs ? ch.paragraphs.map((p) => p.zh).join('\n') : null);
  if (zh === null) return true;
  return sources.some((s) => s && zh.includes(s));
}

export interface BannedHit {
  chapter: string;
  /** 1-based line in the English text */
  line: number;
  variant: string;
  term: string;
  sentence: string;
  /** Set when the hit looks like it belongs to another term (its paragraph has that term's source but not this one's). */
  suspect?: string;
}
/** Every counted banned hit with its sentence, for checking by eye. Same scoping and masking as termDistribution. */
export function bannedHitDetails(entries: GlossaryLike[], chapters: ChapterText[]): BannedHit[] {
  const everyRendering = allRenderings(entries);
  const out: BannedHit[] = [];
  for (const ch of chapters) {
    const lines = ch.en.split('\n');
    // Paragraph alignment for the suspect check: aligned paragraphs, or blank-line blocks when counts match.
    const blocks = ch.en.split(/\n\s*\n/);
    const zhParas = ch.paragraphs?.map((p) => p.zh) ?? (ch.zh ? ch.zh.split(/\n\s*\n|\n/).map((x) => x.trim()).filter(Boolean) : null);
    const aligned = ch.paragraphs ? ch.paragraphs.map((p) => ({ en: p.en, zh: p.zh })) : zhParas && zhParas.length === blocks.length ? blocks.map((b, i) => ({ en: b, zh: zhParas[i] })) : null;
    for (const e of entries) {
      const sources = [e.source, ...e.alias_renderings.map((a) => a.source)];
      if (!termOccursIn(ch, sources)) continue;
      const bannedList = countableBanned(e, entries);
      for (const b of bannedList) {
        // Mask longer legitimate renderings first, then find this variant's occurrences line by line.
        let masked = ch.en;
        for (const r of [...everyRendering].filter((r) => r.length > b.length).sort((x, y) => y.length - x.length)) masked = masked.replace(wordRe(r), (m) => '\u0000'.repeat(m.length));
        const re = wordRe(b);
        let m: RegExpExecArray | null;
        while ((m = re.exec(masked))) {
          const upto = masked.slice(0, m.index);
          const line = upto.split('\n').length;
          const lineText = lines[line - 1] ?? '';
          const sentence = (lineText.match(new RegExp(`[^.!?。]*${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.!?]*[.!?]?`, 'i')) ?? [lineText])[0].trim();
          let suspect: string | undefined;
          // Locate the paragraph by the sentence (a line may hold several paragraphs' text).
          const para = aligned?.find((p) => sentence && p.en.includes(sentence)) ?? aligned?.find((p) => p.en.includes(lineText.trim()));
          if (para) {
            const hasOwn = sources.some((s) => s && para.zh.includes(s));
            const other = entries.find((o) => o !== e && [o.source, ...o.alias_renderings.map((a) => a.source)].some((s) => s && para.zh.includes(s)));
            if (!hasOwn && other) suspect = `paragraph has ${other.source}, not ${e.source}`;
          }
          out.push({ chapter: ch.name, line, variant: b, term: e.source, sentence: sentence.slice(0, 160), suspect });
        }
      }
    }
  }
  return out;
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
    const bannedList = countableBanned(e, entries);
    // Mask every glossary rendering (all entries) before counting, so "audit" inside "Audit Team" is not a hit.
    const variants = [...everyRendering, ...bannedList];
    for (const ch of chapters) {
      const counts = countVariants(ch.en, variants);
      for (const r of renderings) renderingHits += counts.get(r) ?? 0;
      // Chapter scoping: a banned variant for this term only counts in chapters where the term's source occurs.
      if (termOccursIn(ch, sources)) for (const b of bannedList) banned.set(b, (banned.get(b) ?? 0) + (counts.get(b) ?? 0));
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
      const bannedList = countableBanned(e, entries);
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

// ---- Cross-chapter drift ------------------------------------------------------------------------------
export interface DriftReport {
  source: string;
  /** chapter -> forms used (case-folded): the chosen rendering and/or banned variants */
  byChapter: Record<string, string[]>;
}
/**
 * Terms whose rendering changes between chapters: for each term, the set of forms used (chosen rendering or a
 * countable banned variant, case-folded) per chapter where the term's source occurs; a term drifts when two
 * chapters use different sets. Alias renderings are not forms of the main term.
 */
export function crossChapterDrift(entries: GlossaryLike[], chapters: ChapterText[], extraForms?: Map<string, string[]>): DriftReport[] {
  const everyRendering = allRenderings(entries);
  const out: DriftReport[] = [];
  for (const e of entries) {
    // extraForms (eval-only): e.g. the reference's alternates, so a rendering the glossary never listed is still a form.
    const forms = Array.from(new Set([e.rendering, ...countableBanned(e, entries), ...(extraForms?.get(e.source) ?? [])].filter(Boolean)));
    const byChapter: Record<string, string[]> = {};
    for (const ch of chapters) {
      if (!termOccursIn(ch, [e.source])) continue;
      const counts = countVariants(ch.en, [...everyRendering, ...forms]);
      const used = forms.filter((f) => (counts.get(f) ?? 0) > 0).map((f) => f.toLowerCase());
      if (used.length) byChapter[ch.name] = Array.from(new Set(used)).sort();
    }
    const sets = Object.values(byChapter).map((v) => v.join('|'));
    if (sets.length >= 2 && new Set(sets).size > 1) out.push({ source: e.source, byChapter });
  }
  return out;
}

// Pure boundary-entropy candidate extraction. No I/O.
// Counts 2–4 character CJK substrings that occur >= minCount times across >= minParagraphs paragraphs,
// scores them by left/right branching entropy (how varied their neighbours are) times a cohesion term,
// and returns the top N with the paragraph ids where they occur. Nested terms (金丹 inside 金丹期) are
// merged when the shorter never occurs on its own.

export interface CandidateInput {
  /** Paragraph ref, e.g. "p003" or "01.p003" */
  id: string;
  text: string;
}

export interface Candidate {
  source: string;
  count: number;
  paragraph_ids: string[];
  score: number;
  left_entropy: number;
  right_entropy: number;
}

export interface CandidateOptions {
  minLen?: number;
  maxLen?: number;
  minCount?: number;
  minParagraphs?: number;
  top?: number;
}

const CJK = /[㐀-䶿一-鿿]/;
// Function characters that almost never begin or end a term. Cheap noise filter; the LLM confirms the rest.
const STOP_EDGE = new Set('的了是在和也都不我你他她它们这那就有个着与及或把被给让向从到对于呢吗吧啊呀么之其而却又还很太最更才只更没'.split(''));
const BOUNDARY = '\u0000'; // symbol for "run boundary" as a neighbour

function entropy(counts: Map<string, number>): number {
  let total = 0;
  for (const c of counts.values()) total += c;
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Split text into maximal runs of CJK characters (terms never cross punctuation or Latin). */
export function cjkRuns(text: string): string[] {
  const runs: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (CJK.test(ch)) cur += ch;
    else if (cur) {
      runs.push(cur);
      cur = '';
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

interface Stat {
  count: number;
  paras: Set<string>;
  left: Map<string, number>;
  right: Map<string, number>;
}

export function boundaryEntropyCandidates(paragraphs: CandidateInput[], opts: CandidateOptions = {}): Candidate[] {
  const minLen = opts.minLen ?? 2;
  const maxLen = opts.maxLen ?? 4;
  const minCount = opts.minCount ?? 3;
  const minParagraphs = opts.minParagraphs ?? 2;
  const top = opts.top ?? 40;

  const stats = new Map<string, Stat>();
  const charCount = new Map<string, number>();
  let totalChars = 0;

  for (const p of paragraphs) {
    for (const run of cjkRuns(p.text)) {
      const chars = Array.from(run);
      totalChars += chars.length;
      for (const ch of chars) charCount.set(ch, (charCount.get(ch) ?? 0) + 1);
      for (let i = 0; i < chars.length; i++) {
        for (let n = minLen; n <= maxLen && i + n <= chars.length; n++) {
          const s = chars.slice(i, i + n).join('');
          let st = stats.get(s);
          if (!st) {
            st = { count: 0, paras: new Set(), left: new Map(), right: new Map() };
            stats.set(s, st);
          }
          st.count++;
          st.paras.add(p.id);
          const l = i > 0 ? chars[i - 1] : BOUNDARY;
          const r = i + n < chars.length ? chars[i + n] : BOUNDARY;
          st.left.set(l, (st.left.get(l) ?? 0) + 1);
          st.right.set(r, (st.right.get(r) ?? 0) + 1);
        }
      }
    }
  }

  const scored: Candidate[] = [];
  for (const [s, st] of stats) {
    if (st.count < minCount || st.paras.size < minParagraphs) continue;
    const chars = Array.from(s);
    if (STOP_EDGE.has(chars[0]) || STOP_EDGE.has(chars[chars.length - 1])) continue;
    const hl = entropy(st.left);
    const hr = entropy(st.right);
    // Cohesion: how much more often the string occurs than its characters' frequencies predict (min over splits).
    let cohesion = Infinity;
    for (let k = 1; k < chars.length; k++) {
      const a = chars.slice(0, k).join('');
      const b = chars.slice(k).join('');
      const ca = a.length === 1 ? charCount.get(a) ?? 1 : stats.get(a)?.count ?? 1;
      const cb = b.length === 1 ? charCount.get(b) ?? 1 : stats.get(b)?.count ?? 1;
      const pmi = Math.log2((st.count * totalChars) / (ca * cb));
      cohesion = Math.min(cohesion, pmi);
    }
    const coh = Math.max(0, Math.min(8, cohesion)) / 8; // 0..1
    const score = Math.min(hl, hr) * (0.5 + coh) + 0.1 * Math.log2(st.count);
    scored.push({ source: s, count: st.count, paragraph_ids: Array.from(st.paras).sort(), score, left_entropy: hl, right_entropy: hr });
  }

  // Drop time/number expressions before scoring (they recur but are not terms).
  for (let i = scored.length - 1; i >= 0; i--) if (isTimeOrNumber(scored[i].source)) scored.splice(i, 1);
  // Merge nested: drop a shorter candidate that only ever occurs inside one longer candidate with the same count.
  const bySource = new Map(scored.map((c) => [c.source, c]));
  const dropped = new Set<string>();
  for (const c of scored) {
    for (const longer of scored) {
      if (longer.source.length > c.source.length && longer.source.includes(c.source) && longer.count === c.count) {
        dropped.add(c.source);
        break;
      }
    }
  }
  const kept = scored.filter((c) => !dropped.has(c.source) && bySource.has(c.source));
  kept.sort((a, b) => b.score - a.score || b.count - a.count || a.source.localeCompare(b.source));
  return kept.slice(0, top);
}

/** Render candidates for the extractor prompt. */
export function formatCandidates(cands: Candidate[]): string {
  return cands.map((c) => `${c.source}  (×${c.count}; ${c.paragraph_ids.join(', ')})`).join('\n');
}

// ---- Code-side verification of LLM extraction output --------------------------------------------
export interface ExtractedLike {
  source: string;
  type: string;
  paragraph_ids: string[];
  needs_fixed_rendering: boolean;
  reason: string;
}
/** Chinese numerals and time / measure words. A source made only of these is a time or number expression. */
const NUM_TIME = new Set('零〇一二三四五六七八九十百千万亿两几半点分秒钟年月日天周小时刻早晨上午中午下午晚上夜里凌晨傍晚今明昨前后到条个次'.split(''));
export function isTimeOrNumber(source: string): boolean {
  const chars = Array.from(source);
  if (!chars.length) return false;
  const rest = chars.filter((c) => !NUM_TIME.has(c) && !/[0-9０-９:：.．]/.test(c));
  return rest.length === 0;
}

/** Types that may legitimately occur once (a name mentioned a single time still needs a fixed rendering). */
const SINGLE_OK = new Set(['person', 'address_form', 'title', 'org', 'product', 'place', 'homograph']);

export interface FilterResult<T extends ExtractedLike> {
  kept: T[];
  dropped: { source: string; why: string }[];
}

/**
 * Keep only items whose source string literally occurs in the text, recomputing paragraph ids from the
 * text. Terms and phrases must recur (>= minCount occurrences); names/titles/etc. may occur once.
 * Long strings (> maxLen chars) are only kept as 'phrase' when they recur verbatim.
 */
export function verifyExtraction<T extends ExtractedLike>(items: T[], paragraphs: CandidateInput[], opts: { minCount?: number; maxLen?: number; keepSingle?: (item: T) => boolean } = {}): FilterResult<T> {
  const minCount = opts.minCount ?? 2;
  const maxLen = opts.maxLen ?? 12;
  const kept: T[] = [];
  const dropped: { source: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const source = it.source.trim();
    if (!source || seen.has(source)) {
      if (source) dropped.push({ source, why: 'duplicate' });
      continue;
    }
    seen.add(source);
    const ids = paragraphs.filter((p) => p.text.includes(source)).map((p) => p.id);
    let count = 0;
    for (const p of paragraphs) count += p.text.split(source).length - 1;
    if (count === 0) {
      dropped.push({ source, why: 'not found verbatim in text' });
      continue;
    }
    if (isTimeOrNumber(source)) {
      dropped.push({ source, why: 'time/number expression' });
      continue;
    }
    if (count < minCount && !SINGLE_OK.has(it.type) && !opts.keepSingle?.(it)) {
      dropped.push({ source, why: `occurs once (${it.type})` });
      continue;
    }
    if (Array.from(source).length > maxLen && it.type !== 'phrase') {
      dropped.push({ source, why: `longer than ${maxLen} chars and not a phrase` });
      continue;
    }
    kept.push({ ...it, source, paragraph_ids: ids });
  }
  return { kept, dropped };
}

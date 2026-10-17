// Pure helpers for comparing and sanity-checking renderings. No I/O.

export const CJK_RE = /[㐀-䶿一-鿿　-〿＀-￯]/;

/** Raw agreement key: case and whitespace only. */
export function normRaw(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalized agreement key: additionally ignores a leading article, surrounding quotes, and hyphen vs
 * space. Spelling differences (grey/gray) deliberately remain disagreements.
 */
export function normRendering(s: string): string {
  return normRaw(s)
    .replace(/[“”"'‘’«»]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

/** Case-insensitive dedupe preserving first spelling; drops empties and anything equal to `exclude`. */
export function dedupeBanned(banned: string[], exclude: string[] = []): string[] {
  const ex = new Set(exclude.map(normRaw));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of banned) {
    const k = normRaw(b);
    if (!k || seen.has(k) || ex.has(k)) continue;
    seen.add(k);
    out.push(b.trim());
  }
  return out;
}

/** Markdown markup or pinyin tone marks / other diacritics in a rendering: reject and retry. */
export function renderingFormatProblem(s: string): string | null {
  if (/[*_`#~\[\]<>|]/.test(s)) return 'contains markdown or markup characters';
  if (/[\u0300-\u036f]/.test(s.normalize('NFD'))) return 'contains diacritics (tone marks)';
  return null;
}

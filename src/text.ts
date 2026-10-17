// Pure text helpers. No I/O.
export interface Paragraph {
  id: string;
  text: string;
}

/** Split chapter text into non-empty paragraphs with ids p001, p002, ... */
export function splitParagraphs(text: string): Paragraph[] {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n|\n/) // blank-line OR single newline separated (Chinese novels often use one line per paragraph)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return blocks.map((t, i) => ({ id: paragraphId(i + 1), text: t }));
}

export function paragraphId(n: number): string {
  return 'p' + String(n).padStart(3, '0');
}

/** Render paragraphs as the model sees them: one tagged block per paragraph. */
export function formatParagraphs(paragraphs: Paragraph[]): string {
  return paragraphs.map((p) => `[${p.id}]\n${p.text}`).join('\n\n');
}

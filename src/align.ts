// Pure: snap tagger segments back onto the source paragraph.
// Models reliably copy the words but often drop or flip quotation marks at segment edges, or omit a short
// trailing clause. Each segment's core text (edge punctuation trimmed) must occur in order in the source;
// skipped characters are reattached so that the joined segments equal the source exactly. Any real
// alteration of the text (a changed character) is a hard mismatch and is reported with its position.
import type { TaggedSegment } from './schemas';

const P = '\\s“”‘’"\'「」『』（）()《》〈〉【】,.，。！？!?、；;：:…—-';
const EDGE = new RegExp(`^[${P}]+|[${P}]+$`, 'g');
const LEAD_PUNCT = new RegExp(`^[${P}]*`);
const PUNCT_ONLY = new RegExp(`^[${P}]*$`);
const OPENING = /[“‘"'「『（(《〈【]/;

export type AlignResult = { ok: true; segments: TaggedSegment[]; adjusted: boolean } | { ok: false; index: number; detail: string };

const narration = (text: string): TaggedSegment => ({ type: 'narration', text, speaker: '', addressee: '', address_form: '' });

export function alignSegments(source: string, segments: TaggedSegment[]): AlignResult {
  const joined = segments.map((s) => s.text).join('');
  if (joined === source) return { ok: true, segments, adjusted: false };

  const out: TaggedSegment[] = [];
  let pos = 0;
  let prefix = ''; // characters waiting to be attached to the start of the next segment

  const appendPrev = (text: string) => {
    if (!text) return;
    if (out.length) out[out.length - 1].text += text;
    else prefix += text;
  };
  const addNarration = (text: string) => {
    if (!text) return;
    if (out.length && out[out.length - 1].type === 'narration') out[out.length - 1].text += text;
    else out.push(narration(text));
  };
  /** Distribute characters the model skipped between two segments. */
  const distribute = (skipped: string, hasNext: boolean) => {
    if (!skipped) return;
    const lead = skipped.match(LEAD_PUNCT)![0];
    const rest = skipped.slice(lead.length);
    if (!rest) {
      // Pure punctuation: an opening quote (and what follows) belongs to the next segment.
      const open = hasNext ? lead.search(OPENING) : -1;
      if (open >= 0) {
        appendPrev(lead.slice(0, open));
        prefix += lead.slice(open);
      } else appendPrev(lead);
      return;
    }
    appendPrev(lead);
    // Real text the model dropped: keep as narration; a trailing opening quote goes to the next segment.
    let mid = rest;
    if (hasNext) {
      const lastOpen = Math.max(...Array.from(rest).map((ch, i) => (OPENING.test(ch) ? i : -1)));
      if (lastOpen >= 0 && PUNCT_ONLY.test(rest.slice(lastOpen))) {
        mid = rest.slice(0, lastOpen);
        prefix += rest.slice(lastOpen);
      }
    }
    addNarration(mid);
  };

  for (const seg of segments) {
    const core = seg.text.replace(EDGE, '');
    if (!core) continue; // punctuation-only segment: its characters get reattached by distribute()
    const idx = source.indexOf(core, pos);
    if (idx < 0) {
      // Report the first altered character, ignoring any edge punctuation the model dropped.
      const start = pos + (source.slice(pos).match(LEAD_PUNCT)![0].length);
      let i = 0;
      while (i < core.length && source[start + i] === core[i]) i++;
      return { ok: false, index: start + i, detail: `segment text not found in source: "${core.slice(0, 20)}…"` };
    }
    distribute(source.slice(pos, idx), true);
    out.push({ ...seg, text: prefix + core });
    prefix = '';
    pos = idx + core.length;
  }
  distribute(source.slice(pos), false);
  if (prefix) appendPrev(prefix);

  const check = out.map((s) => s.text).join('');
  if (check !== source) {
    let i = 0;
    while (i < Math.min(check.length, source.length) && check[i] === source[i]) i++;
    return { ok: false, index: i, detail: 'realignment did not reproduce source' };
  }
  return { ok: true, segments: out, adjusted: true };
}

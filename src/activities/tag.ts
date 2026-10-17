import { ApplicationFailure } from '@temporalio/common';
import { MODELS } from '../config';
import { alignSegments } from '../align';
import { chatJson } from '../llm';
import { taggerPrompt } from '../prompts';
import { TaggedChapterSchema, type TaggedChapter, type Usage } from '../schemas';
import { formatParagraphs, splitParagraphs } from '../text';
import { readText, runDir, writeJsonAtomic } from './io';
import { attemptSeed, chapterNameOf, modelForAttempt, withHeartbeat } from './common';

export interface TagChapterInput {
  runId: string;
  chapterPath: string;
}
export interface TagChapterOutput {
  chapterName: string;
  taggedPath: string;
  addressFormsPath: string;
  paragraphCount: number;
  segmentCount: number;
  usage: Usage;
}

/** speaker → addressee: form, with counts. Derived in code from the tagger output. */
export interface AddressForm {
  speaker: string;
  addressee: string;
  form: string;
  count: number;
  paragraph_ids: string[];
}

const PLACEHOLDERS = new Set(['', 'unknown', 'none', 'null', 'n/a', '无', '不明', '未知', 'narrator', '旁白']);
const clean = (v: string | null | undefined): string => (v && !PLACEHOLDERS.has(v.trim().toLowerCase()) ? v.trim() : '');

/** Normalize label fields: narration carries no speaker; placeholder strings become "". Text is untouched. */
export function normalizeSegments(tagged: TaggedChapter): TaggedChapter {
  return {
    paragraphs: tagged.paragraphs.map((p) => ({
      id: p.id,
      segments: p.segments.map((s) =>
        s.type === 'narration'
          ? { ...s, speaker: '', addressee: '', address_form: '' }
          : { ...s, speaker: clean(s.speaker) || 'unknown', addressee: clean(s.addressee), address_form: clean(s.address_form) },
      ),
    })),
  };
}

export function deriveAddressForms(tagged: TaggedChapter, chapterName?: string): AddressForm[] {
  const map = new Map<string, AddressForm>();
  for (const p of tagged.paragraphs) {
    for (const s of p.segments) {
      if (s.type === 'narration' || !clean(s.address_form)) continue;
      // A form equal to the addressee's own name is just the name, not a form of address worth recording.
      if (clean(s.address_form) === clean(s.addressee)) continue;
      const speaker = s.speaker || 'unknown';
      const addressee = s.addressee || 'unknown';
      const key = `${speaker}\u0000${addressee}\u0000${s.address_form}`;
      const ref = chapterName ? `${chapterName}.${p.id}` : p.id;
      const cur = map.get(key);
      if (cur) {
        cur.count++;
        if (!cur.paragraph_ids.includes(ref)) cur.paragraph_ids.push(ref);
      } else map.set(key, { speaker, addressee, form: s.address_form, count: 1, paragraph_ids: [ref] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.form.localeCompare(b.form, 'zh'));
}

export function formatAddressForms(rows: AddressForm[]): string {
  if (!rows.length) return '(none observed)';
  return rows.map((r) => `${r.speaker} → ${r.addressee}: ${r.form}  (×${r.count}; ${r.paragraph_ids.join(', ')})`).join('\n');
}

export async function tagChapter(input: TagChapterInput): Promise<TagChapterOutput> {
  return withHeartbeat(async () => {
    const chapterName = chapterNameOf(input.chapterPath);
    const source = await readText(input.chapterPath);
    const paragraphs = splitParagraphs(source);
    const prompt = taggerPrompt(formatParagraphs(paragraphs));
    const res = await chatJson(
      { model: modelForAttempt(MODELS.tagger, MODELS.smart), ...prompt, schemaName: 'tagging', maxTokens: Math.max(8192, source.length * 6), seed: attemptSeed(), enableThinking: false },
      TaggedChapterSchema,
    );

    // Code check: joined segments must reproduce each source paragraph exactly. Dropped/flipped quotes at
    // segment edges are snapped back onto the source (alignSegments); any altered character is a failure.
    const byId = new Map(res.data.paragraphs.map((p) => [p.id, p]));
    let adjusted = 0;
    for (const p of paragraphs) {
      const got = byId.get(p.id);
      if (!got) throw ApplicationFailure.create({ type: 'TagMismatch', message: `${p.id}: missing from tagger output`, nonRetryable: false });
      const joined = got.segments.map((s) => s.text).join('');
      const r = alignSegments(p.text, got.segments);
      if (!r.ok) {
        const i = r.index;
        throw ApplicationFailure.create({
          type: 'TagMismatch',
          message: `${p.id}: joined segments differ from source at char ${i} (${r.detail}): source "…${p.text.slice(Math.max(0, i - 8), i + 12)}…" vs tagged "…${joined.slice(Math.max(0, i - 8), i + 12)}…"`,
          nonRetryable: false,
        });
      }
      if (r.adjusted) adjusted++;
      got.segments = r.segments;
    }
    if (adjusted) console.log(`[tag] ${chapterName}: realigned segment boundaries in ${adjusted}/${paragraphs.length} paragraphs`);
    const extra = res.data.paragraphs.filter((p) => !paragraphs.some((s) => s.id === p.id)).map((p) => p.id);
    if (extra.length) throw ApplicationFailure.create({ type: 'TagMismatch', message: `unexpected paragraph ids: ${extra.join(', ')}`, nonRetryable: false });

    const ordered: TaggedChapter = normalizeSegments({ paragraphs: paragraphs.map((p) => byId.get(p.id)!) });
    const addressForms = deriveAddressForms(ordered, chapterName);
    const dir = runDir(input.runId, 'chapters', chapterName);
    const taggedPath = `${dir}/tagged.json`;
    const addressFormsPath = `${dir}/address-forms.json`;
    await writeJsonAtomic(taggedPath, { chapter: chapterName, source: input.chapterPath, ...ordered });
    await writeJsonAtomic(addressFormsPath, addressForms);
    await writeJsonAtomic(`${dir}/tag.usage.json`, res.usage);
    return { chapterName, taggedPath, addressFormsPath, paragraphCount: ordered.paragraphs.length, segmentCount: ordered.paragraphs.reduce((n, p) => n + p.segments.length, 0), usage: res.usage };
  });
}

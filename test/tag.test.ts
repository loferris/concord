import { describe, expect, it } from 'vitest';
import { deriveAddressForms, normalizeSegments } from '../src/activities/tag';

const tagged = {
  paragraphs: [
    { id: 'p001', segments: [{ type: 'narration' as const, text: '夜已深。', speaker: 'unknown', addressee: 'unknown', address_form: 'unknown' }] },
    { id: 'p004', segments: [{ type: 'speech' as const, text: '“沈哥，你看。”', speaker: '陆楠', addressee: '沈澈', address_form: '沈哥' }, { type: 'narration' as const, text: '她说。', speaker: '', addressee: '', address_form: '' }] },
    { id: 'p009', segments: [{ type: 'speech' as const, text: '“小鹿。”', speaker: '沈澈', addressee: '陆楠', address_form: '小鹿' }] },
    { id: 'p017', segments: [{ type: 'speech' as const, text: '“沈哥。”', speaker: '陆楠', addressee: '沈澈', address_form: '沈哥' }] },
    { id: 'p020', segments: [{ type: 'speech' as const, text: '“嗯。”', speaker: 'none', addressee: 'N/A', address_form: 'none' }] },
    { id: 'p021', segments: [{ type: 'speech' as const, text: '“沈澈。”', speaker: '周总', addressee: '沈澈', address_form: '沈澈' }] },
  ],
};

describe('normalizeSegments', () => {
  it('blanks placeholder labels and narration speakers without touching text', () => {
    const n = normalizeSegments(tagged);
    expect(n.paragraphs[0].segments[0]).toEqual({ type: 'narration', text: '夜已深。', speaker: '', addressee: '', address_form: '' });
    expect(n.paragraphs[4].segments[0]).toEqual({ type: 'speech', text: '“嗯。”', speaker: 'unknown', addressee: '', address_form: '' });
  });
});

describe('deriveAddressForms', () => {
  it('counts speaker → addressee: form, ignoring placeholders', () => {
    const rows = deriveAddressForms(normalizeSegments(tagged), '01');
    expect(rows).toEqual([
      { speaker: '陆楠', addressee: '沈澈', form: '沈哥', count: 2, paragraph_ids: ['01.p004', '01.p017'] },
      { speaker: '沈澈', addressee: '陆楠', form: '小鹿', count: 1, paragraph_ids: ['01.p009'] },
    ]);
  });
});

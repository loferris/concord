import { describe, expect, it } from 'vitest';
import { alignSegments } from '../src/align';
import type { TaggedSegment } from '../src/schemas';

const sp = (text: string, speaker = '陆楠'): TaggedSegment => ({ type: 'speech', text, speaker, addressee: '', address_form: '' });
const na = (text: string): TaggedSegment => ({ type: 'narration', text, speaker: '', addressee: '', address_form: '' });
const join = (r: ReturnType<typeof alignSegments>) => (r.ok ? r.segments.map((s) => s.text).join('') : null);

describe('alignSegments', () => {
  it('passes exact output through unchanged', () => {
    const src = '“沈哥，你看这个。”陆楠把椅子滑过来。';
    const r = alignSegments(src, [sp('“沈哥，你看这个。”'), na('陆楠把椅子滑过来。')]);
    expect(r.ok && !r.adjusted).toBe(true);
  });

  it('restores dropped quotation marks onto the speech segment', () => {
    const src = '“沈哥，你看这个。”陆楠把椅子滑过来。';
    const r = alignSegments(src, [sp('沈哥，你看这个。'), na('陆楠把椅子滑过来。')]);
    expect(join(r)).toBe(src);
    expect(r.ok && r.segments[0].text).toBe('“沈哥，你看这个。”');
    expect(r.ok && r.segments[1].text).toBe('陆楠把椅子滑过来。');
  });

  it('fixes a flipped closing quote after a nested quote', () => {
    const src = '他说：“那个叫‘清野生活’。”';
    const r = alignSegments(src, [na('他说：'), sp('“那个叫‘清野生活’。“')]);
    expect(join(r)).toBe(src);
  });

  it('keeps a dropped trailing clause as narration', () => {
    const src = '“系统自己改的？”沈澈问。';
    const r = alignSegments(src, [sp('“系统自己改的？”', '沈澈')]);
    expect(join(r)).toBe(src);
    expect(r.ok && r.segments[1]).toEqual(na('沈澈问。'));
  });

  it('fails with a position when the text was actually altered', () => {
    const src = '“我知道。”';
    const r = alignSegments(src, [sp('我所知。')]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.index).toBe(2);
  });

  it('leaves an exact split alone even if the quote sits on the narration side', () => {
    const src = '陆楠小声说：“沈哥。”';
    const r = alignSegments(src, [na('陆楠小声说：“'), sp('沈哥。”')]);
    expect(r.ok && !r.adjusted).toBe(true);
  });

  it('moves a dropped opening quote to the speech segment when the split is inexact', () => {
    const src = '陆楠小声说：“沈哥。”';
    const r = alignSegments(src, [na('陆楠小声说：'), sp('沈哥。')]);
    expect(join(r)).toBe(src);
    expect(r.ok && r.segments[1].text).toBe('“沈哥。”');
  });
});

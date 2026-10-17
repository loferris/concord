import { describe, expect, it } from 'vitest';
import { dedupeBanned, hasCJK, normRaw, normRendering } from '../src/normalize';

describe('rendering normalization', () => {
  it('raw key ignores case and whitespace only', () => {
    expect(normRaw(' Grey  List ')).toBe('grey list');
    expect(normRaw('the Grey List')).not.toBe(normRaw('Grey List'));
  });
  it('normalized key ignores articles, quotes, hyphen/space', () => {
    expect(normRendering('the Grey List')).toBe('grey list');
    expect(normRendering('"Grey-List"')).toBe('grey list');
    expect(normRendering('Night Voyage')).toBe(normRendering('night-voyage'));
  });
  it('keeps spelling differences as disagreements', () => {
    expect(normRendering('Grey List')).not.toBe(normRendering('Gray List'));
  });
  it('detects CJK and full-width punctuation', () => {
    expect(hasCJK('Shen Che')).toBe(false);
    expect(hasCJK('Shen 澈')).toBe(true);
    expect(hasCJK('Shen，Che')).toBe(true);
  });
  it('dedupes banned case-insensitively and excludes the rendering', () => {
    expect(dedupeBanned(['Gray List', 'gray list', '', 'Grey List', 'Greylist'], ['Grey List'])).toEqual(['Gray List', 'Greylist']);
  });
});

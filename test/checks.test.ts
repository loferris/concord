import { describe, expect, it } from 'vitest';
import { nestedTermViolations } from '../src/checks';

const g = (source: string, rendering: string) => ({ source, rendering, alias_renderings: [], banned: [] });

describe('nestedTermViolations', () => {
  it('flags a longer term whose rendering does not contain the shorter term rendering', () => {
    const v = nestedTermViolations([g('复核组', 'Review Group'), g('复核组的组长', 'Head of the Review Team'), g('复核', 'review')]);
    expect(v.map((x) => `${x.source}⊃${x.within}`)).toEqual(['复核组的组长⊃复核组']);
  });
  it('accepts containment after normalization', () => {
    expect(nestedTermViolations([g('灰名单', 'grey list'), g('灰名单账号', 'the Grey-List accounts')])).toEqual([]);
  });
});

import { leftoverCJK, renderingCollisions, summarize, termDistribution } from '../src/checks';

describe('termDistribution and friends', () => {
  const glossary = [
    { source: '灰名单', rendering: 'graylist', alias_renderings: [], banned: ['grey list', 'gray list'] },
    { source: '沈澈', rendering: 'Shen Che', alias_renderings: [{ source: '沈哥', rendering: 'Shen' }], banned: ['Shen Jie'] },
  ];
  const chapters = [
    {
      name: '01',
      en: 'Shen Che opened the graylist. "Shen, look," said Lu Nan. The grey list had 3,412 entries. Shen Jie frowned. 夜航',
      paragraphs: [
        { id: 'p001', zh: '沈澈打开灰名单。', en: 'Shen Che opened the graylist.' },
        { id: 'p002', zh: '“沈哥，你看。”', en: '"Shen, look," said Lu Nan.' },
        { id: 'p003', zh: '灰名单有三千条。沈澈皱眉。', en: 'The grey list had 3,412 entries. Shen Jie frowned. 夜航' },
      ],
    },
  ];
  it('counts renderings, banned variants and per-paragraph coverage', () => {
    const [grey, shen] = termDistribution(glossary, chapters);
    expect(grey.renderingHits).toBe(1);
    expect(grey.bannedHits).toEqual([{ variant: 'grey list', count: 1 }]);
    expect(grey.coverage).toEqual({ covered: 1, total: 2 });
    expect(shen.renderingHits).toBe(2); // Shen Che + Shen (alias); "Shen Jie" does not match "Shen" as a whole word? it does match "Shen" inside "Shen Jie"
    expect(shen.bannedHits).toEqual([{ variant: 'Shen Jie', count: 1 }]);
  });
  it('finds leftover CJK with paragraph ids and collisions', () => {
    expect(leftoverCJK(chapters)).toEqual([{ chapter: '01', paragraphId: 'p003', snippet: '夜航' }]);
    expect(renderingCollisions([{ source: 'a', rendering: 'Review Team', alias_renderings: [], banned: [] }, { source: 'b', rendering: 'the review-team', alias_renderings: [], banned: [] }])).toEqual([{ rendering: 'review team', sources: ['a', 'b'] }]);
  });
  it('summarizes', () => {
    const s = summarize(termDistribution(glossary, chapters), leftoverCJK(chapters), 0, 0);
    expect(s.bannedHits).toBe(2);
    expect(s.cjkLeaks).toBe(1);
    expect(s.consistency).toBeCloseTo(3 / 5);
  });
});

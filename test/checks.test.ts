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

import { ambiguousBannedVariants, leftoverCJK, lintParagraphs, renderingCollisions, summarize, termDistribution } from '../src/checks';

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

describe('inflections', () => {
  it('accepts inflected forms of lowercase single-word terms but not of proper nouns', () => {
    const g = [{ source: '复核', rendering: 'review', alias_renderings: [], banned: ['audit'] }, { source: '沈澈', rendering: 'Shen Che', alias_renderings: [], banned: [] }];
    const [rev, shen] = termDistribution(g, [{ name: 'x', en: 'accounts had to be manually reviewed; the audits were wrong; Shen Ches is not a name', paragraphs: [{ id: 'p1', zh: '复核', en: 'manually reviewed' }] }]);
    expect(rev.renderingHits).toBe(1);
    expect(rev.bannedHits).toEqual([{ variant: 'audit', count: 1 }]);
    expect(rev.coverage).toEqual({ covered: 1, total: 1 });
    expect(shen.renderingHits).toBe(0);
  });
});

describe('ambiguous banned variants', () => {
  const g = [
    { source: '师父', rendering: 'Master', alias_renderings: [], banned: ['Shifu'] },
    { source: '师傅', rendering: 'driver', alias_renderings: [], banned: ['master', 'mentor', 'sir'] },
    { source: '顾衡', rendering: 'Gu Heng', alias_renderings: [{ source: '师父', rendering: 'the Master' }], banned: [] },
  ];
  it('lists a banned variant that is another entry\'s rendering or alias rendering (normalized)', () => {
    expect(ambiguousBannedVariants(g)).toEqual([{ source: '师傅', variant: 'master', conflictsWith: '师父' }]);
  });
  it('does not count the ambiguous variant against the term, but still counts the others', () => {
    const text = 'His master nodded. The mentor smiled. "Sir," said the driver.';
    const [, shifu] = termDistribution(g, [{ name: 'x', en: text }]);
    expect(shifu.bannedHits).toEqual([{ variant: 'mentor', count: 1 }, { variant: 'sir', count: 1 }]);
    const lint = lintParagraphs(g, [{ id: 'p1', zh: '师傅说。', en: 'His master nodded, said the driver.' }]);
    expect(lint.filter((v) => v.kind === 'banned_variant')).toEqual([]);
  });
});

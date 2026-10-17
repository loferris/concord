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

import { ambiguousBannedVariants, bannedHitDetails, crossChapterDrift, leftoverCJK, lintParagraphs, renderingCollisions, summarize, termDistribution } from '../src/checks';

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

describe('chapter-scoped banned counting', () => {
  const g = [
    { source: '师傅', rendering: 'driver', alias_renderings: [], banned: ['mentor'] },
    { source: '师父', rendering: 'Shifu', alias_renderings: [], banned: [] },
  ];
  const chapters = [
    { name: '02', en: 'His mentor had left three years ago.', zh: '师父三年前离开了。' }, // 师傅 absent: not counted
    { name: '03', en: 'The driver nodded. His mentor waited at the airport.', paragraphs: [{ id: 'p1', zh: '师傅点头。', en: 'The driver nodded.' }, { id: 'p2', zh: '师父在机场等。', en: 'His mentor waited at the airport.' }] },
  ];
  it('counts a banned variant only in chapters where the term occurs', () => {
    const [shifu] = termDistribution(g, chapters);
    expect(shifu.bannedHits).toEqual([{ variant: 'mentor', count: 1 }]);
  });
  it('lists hits with chapter:line and flags a hit whose paragraph belongs to the other term', () => {
    const hits = bannedHitDetails(g, chapters);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ chapter: '03', line: 1, variant: 'mentor', term: '师傅' });
    expect(hits[0].suspect).toMatch(/师父/);
  });
});

describe('crossChapterDrift', () => {
  const g = [
    { source: '师父', rendering: 'Shi Fu', alias_renderings: [], banned: ['mentor', 'Master', 'Shifu'] },
    { source: '夜航', rendering: 'Ye Hang', alias_renderings: [], banned: ['Night Voyage'] },
  ];
  const chapters = [
    { name: '02', en: 'His mentor had left. Night Voyage tagged users.', zh: '师父走了。夜航打标签。' },
    { name: '03', en: 'Chapter 3: The Master. "Shifu," he said. Night Voyage again.', zh: '第三章 师父。“师父。”夜航。' },
  ];
  it('counts a term whose forms differ between chapters, not one used the same way everywhere', () => {
    const d = crossChapterDrift(g, chapters);
    expect(d.map((x) => x.source)).toEqual(['师父']);
    expect(d[0].byChapter).toEqual({ '02': ['mentor'], '03': ['master', 'shifu'] });
  });
});

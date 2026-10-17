import { describe, expect, it } from 'vitest';
import { factCounts, glossaryAgreement, parseReferenceGlossary } from '../src/eval';

const md = `## Glossary the agents should converge on

| Source | Reference rendering | Notes |
|---|---|---|
| 沈哥 | "Shen" / "boss" (Lu Nan's address) | informal |
| 周总 | Director Zhou (or "Ms. Zhou") | title |
| 白名单 / 黑名单 / 灰名单 | whitelist / blacklist / grey list | keep consistent |
| 观澜数据 | Guanlan Data | the company |

## Chapter 1 — x
`;

describe('reference glossary parsing and agreement', () => {
  const rows = parseReferenceGlossary(md);
  it('parses alternates, parentheticals and positional slash rows', () => {
    expect(rows[0]).toMatchObject({ sources: ['沈哥'], alternates: [['Shen', 'boss']] });
    expect(rows[1].alternates[0]).toEqual(['Director Zhou', 'Ms. Zhou']);
    expect(rows[2].sources).toEqual(['白名单', '黑名单', '灰名单']);
    expect(rows[2].alternates[2]).toEqual(['grey list']);
  });
  it('matches on normalized rendering, including aliases and contained sources', () => {
    const entries = [
      { source: '沈澈', rendering: 'Shen Che', alias_renderings: [{ source: '沈哥', rendering: 'Brother Shen' }], decided_by: 'agreement' },
      { source: '周总', rendering: 'Director Zhou', alias_renderings: [], decided_by: 'agreement' },
      { source: '灰名单', rendering: 'graylist', alias_renderings: [], decided_by: 'agreement' },
      { source: '观澜', rendering: 'Guanlan', alias_renderings: [], decided_by: 'human' },
    ] as never;
    const r = glossaryAgreement(entries, rows);
    expect(r.compared).toBe(4);
    expect(r.matches).toBe(2); // Director Zhou; Guanlan ⊂ Guanlan Data
    expect(r.mismatches.map((m) => m.source)).toEqual(['沈哥', '灰名单']);
    expect(r.notInGlossary).toEqual(['白名单', '黑名单']);
  });
});

describe('fact ledger', () => {
  it('counts the facts with number and word forms', () => {
    const c = factCounts('3,412 accounts moved between 1 and 2 a.m.; 72 hours; two hundred million users; nine years; three years; two months; about 300 accounts; at 11 p.m.; at 8 a.m.');
    expect(Object.values(c).every((v) => v >= 1)).toBe(true);
  });
});

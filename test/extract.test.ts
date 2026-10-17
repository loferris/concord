import { describe, expect, it } from 'vitest';
import { boundaryEntropyCandidates, cjkRuns } from '../src/extract';

const paras = [
  { id: 'p001', text: '沈澈第三次刷新后台的时候，那条数据还在。夜航是一个模型。' },
  { id: 'p002', text: '“沈哥，你看这个。”陆楠把椅子滑过来。夜航把两亿用户分类。' },
  { id: 'p003', text: '陆楠愣了一下。沈澈很少叫她小鹿。操作人：夜航。' },
  { id: 'p004', text: '沈澈把表格发给周总。陆楠在黑暗里说：“沈哥。”夜航会改标签。' },
  { id: 'p005', text: '周总回了一句。沈澈关掉屏幕，灰名单上的账号都是真人。灰名单要人工复核。' },
  { id: 'p006', text: '白名单是正常用户，灰名单是“说不清”。小鹿把灰名单拉出来给沈哥。' },
];

describe('cjkRuns', () => {
  it('splits on punctuation and non-CJK', () => {
    expect(cjkRuns('沈澈说：“你好”，abc 陆楠。')).toEqual(['沈澈说', '你好', '陆楠']);
  });
});

describe('boundaryEntropyCandidates', () => {
  const cands = boundaryEntropyCandidates(paras, { minCount: 3, minParagraphs: 2, top: 40 });
  const sources = cands.map((c) => c.source);

  it('finds frequent names and terms', () => {
    expect(sources).toContain('沈澈');
    expect(sources).toContain('夜航');
    expect(sources).toContain('灰名单');
    expect(sources).toContain('陆楠');
  });

  it('records paragraph ids and counts', () => {
    const ye = cands.find((c) => c.source === '夜航')!;
    expect(ye.count).toBe(4);
    expect(ye.paragraph_ids).toEqual(['p001', 'p002', 'p003', 'p004']);
  });

  it('drops candidates whose edge is a function character', () => {
    expect(sources.some((s) => s.startsWith('的') || s.endsWith('的'))).toBe(false);
  });

  it('merges nested substrings that never occur alone', () => {
    // 名单 occurs inside 灰名单 (×4) and 白名单 (×1): count differs from 灰名单 so it stays; but
    // 灰名 only ever occurs inside 灰名单 with the same count and must be dropped.
    expect(sources).not.toContain('灰名');
  });

  it('respects thresholds', () => {
    expect(boundaryEntropyCandidates(paras, { minCount: 100 })).toEqual([]);
    expect(boundaryEntropyCandidates(paras, { top: 2 }).length).toBe(2);
  });
});

import { isTimeOrNumber, verifyExtraction } from '../src/extract';

describe('isTimeOrNumber', () => {
  it('flags time and number expressions, not terms', () => {
    for (const t of ['八点', '凌晨一点', '凌晨一点到两点', '三千四百一十二条', '三年前', '七十二小时', '1:17', '今天早上']) expect(isTimeOrNumber(t), t).toBe(true);
    for (const t of ['夜航', '灰名单', '复核组', '小会议室', '沈澈', '三年之约']) expect(isTimeOrNumber(t), t).toBe(false);
  });
});

describe('verifyExtraction', () => {
  const paras = [
    { id: '01.p001', text: '沈澈看着夜航的日志。' },
    { id: '01.p002', text: '“沈哥。”陆楠说。夜航改了标签。' },
    { id: '02.p001', text: '顾衡只出现了一次。夜航为什么只在凌晨改标签，没人知道。' },
  ];
  const mk = (source: string, type: string) => ({ source, type, paragraph_ids: ['x'], needs_fixed_rendering: true, reason: '' });

  it('drops items that are not verbatim in the text', () => {
    const r = verifyExtraction([mk("操作人是 '夜航' 的记录", 'phrase')], paras);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0].why).toMatch(/not found/);
  });
  it('keeps single-occurrence names but not single-occurrence terms', () => {
    const r = verifyExtraction([mk('顾衡', 'person'), mk('日志', 'term')], paras);
    expect(r.kept.map((k) => k.source)).toEqual(['顾衡']);
  });
  it('recomputes paragraph ids from the text', () => {
    const r = verifyExtraction([mk('夜航', 'product')], paras);
    expect(r.kept[0].paragraph_ids).toEqual(['01.p001', '01.p002', '02.p001']);
  });
  it('drops long non-phrase strings and duplicates', () => {
    const r = verifyExtraction([mk('夜航为什么只在凌晨改标签', 'term'), mk('夜航', 'product'), mk('夜航', 'product')], paras);
    expect(r.kept.map((k) => k.source)).toEqual(['夜航']);
    expect(r.dropped.map((d) => d.why)).toEqual([expect.stringMatching(/occurs once|longer/), 'duplicate']);
  });
});

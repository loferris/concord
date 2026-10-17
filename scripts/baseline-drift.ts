// Read-only: which renderings the baseline used for each glossary term, per chapter.
// Candidates per term = rendering + alias renderings + banned variants (parenthetical notes stripped).
// A candidate equal to another entry's rendering/alias rendering is dropped; a banned variant shared by
// two entries is kept but marked ambiguous. Matching is case-insensitive on word boundaries, longest
// candidate first, and each span of text is counted once.
// Usage: bunx tsx scripts/baseline-drift.ts <runId> [glossaryVersion]
import { readFile, readdir } from 'node:fs/promises';

interface Entry { source: string; rendering: string; alias_renderings?: { source: string; rendering: string }[]; banned?: string[] }

const norm = (s: string) => s.toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const [runId, v] = process.argv.slice(2);
  const gdir = `run-data/${runId}/glossary`;
  const version = v ?? String(Math.max(...(await readdir(gdir)).map((f) => /^glossary\.v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number)));
  const entries = (JSON.parse(await readFile(`${gdir}/glossary.v${version}.json`, 'utf8')) as { entries: Entry[] }).entries;

  // Renderings (main + alias) owned by each entry.
  const owner = new Map<string, string>();
  for (const e of entries) for (const r of [e.rendering, ...(e.alias_renderings ?? []).map((a) => a.rendering)]) owner.set(norm(r), e.source);

  type Cand = { text: string; term: string; kind: 'rendering' | 'alias' | 'banned'; ambiguous?: string[] };
  const cands: Cand[] = [];
  const dropped: string[] = [];
  for (const e of entries) {
    const seen = new Set<string>();
    const add = (text: string, kind: Cand['kind']) => {
      text = text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (!text || /[㐀-鿿]/.test(text) || seen.has(norm(text))) return;
      seen.add(norm(text));
      const o = owner.get(norm(text));
      if (o && o !== e.source) { dropped.push(`${e.source}: "${text}" (rendering of ${o})`); return; }
      cands.push({ text, term: e.source, kind });
    };
    add(e.rendering, 'rendering');
    for (const a of e.alias_renderings ?? []) add(a.rendering, 'alias');
    for (const b of e.banned ?? []) add(b, 'banned');
  }
  const byText = new Map<string, Cand[]>();
  for (const c of cands) byText.set(norm(c.text), [...(byText.get(norm(c.text)) ?? []), c]);
  for (const list of byText.values()) if (list.length > 1) for (const c of list) c.ambiguous = list.filter((x) => x !== c).map((x) => x.term);

  // Longest first; one regex per distinct candidate text.
  const texts = [...byText.keys()].sort((a, b) => b.length - a.length);
  const res = texts.map((t) => ({ t, re: new RegExp(`(?<![\\p{L}\\p{N}])${esc(t).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu') }));

  const bdir = `run-data/${runId}/baseline`;
  const chapters = (await readdir(bdir)).filter((f) => f.endsWith('.en.txt')).sort().map((f) => f.slice(0, 2));
  // hits[term][chapter][surface text] = line numbers
  const hits = new Map<string, Map<string, Map<string, number[]>>>();
  const zhCount = new Map<string, Map<string, number>>();
  for (const ch of chapters) {
    const zh = await readFile(`data/zh/${ch}.txt`, 'utf8').catch(() => '');
    for (const e of entries) {
      const m = zhCount.get(e.source) ?? new Map();
      m.set(ch, zh.split(e.source).length - 1);
      zhCount.set(e.source, m);
    }
    const lines = (await readFile(`${bdir}/${ch}.en.txt`, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const used = new Array(line.length).fill(false);
      for (const { t, re } of res) {
        for (const m of line.matchAll(re)) {
          const s = m.index!, end = s + m[0].length;
          if (used.slice(s, end).some(Boolean)) continue;
          used.fill(true, s, end);
          for (const c of byText.get(t)!) {
            const label = `${m[0]}${c.kind === 'rendering' ? '' : ` [${c.kind}${c.ambiguous ? `, ambiguous with ${c.ambiguous.join('/')}` : ''}]`}`;
            const perCh = hits.get(c.term) ?? new Map();
            const perText = perCh.get(ch) ?? new Map();
            perText.set(label, [...(perText.get(label) ?? []), i + 1]);
            perCh.set(ch, perText);
            hits.set(c.term, perCh);
          }
        }
      }
    });
  }

  console.log(`== Baseline renderings per term — ${runId}, glossary v${version}, chapters ${chapters.join(' ')}`);
  const drifting: string[] = [];
  for (const e of entries) {
    const perCh = hits.get(e.source) ?? new Map();
    const zc = chapters.map((ch) => `${ch}:${zhCount.get(e.source)!.get(ch)}`).join(' ');
    console.log(`\n${e.source} → ${e.rendering}   (source occurrences ${zc})`);
    const forms = new Set<string>();
    for (const ch of chapters) {
      const perText = perCh.get(ch);
      if (!perText) { console.log(`  ${ch}  —`); continue; }
      const parts = [...perText].map(([label, ln]) => { forms.add(norm(label)); return `${label} ×${ln.length} (L${ln.join(',')})`; });
      console.log(`  ${ch}  ${parts.join(' | ')}`);
    }
    if (forms.size > 1) drifting.push(e.source);
  }
  console.log(`\n== Terms with more than one baseline rendering: ${drifting.join(', ') || 'none'}`);
  if (dropped.length) console.log(`== Candidates dropped (another entry's rendering): ${dropped.join('; ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

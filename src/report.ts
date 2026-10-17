// Static HTML report generated from run files only (no network, no JS framework).
import { readFile, readdir } from 'node:fs/promises';
import { computeAblation, factCounts, glossaryAgreement, loadBaselineChapters, referenceEnglish, referenceGlossary, type Ablation } from './eval';
import { ambiguousBannedVariants, type CheckSummary } from './checks';
import type { Glossary, GlossaryEntry } from './schemas';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const usd = (n: number) => `$${n.toFixed(4)}`;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function buildReport(runDataDir: string, runId: string, glossaryRunId?: string): Promise<string> {
  const ab = await computeAblation(runDataDir, runId, glossaryRunId);
  const gDir = `${runDataDir}/${ab.glossaryRunId}/glossary`;
  const g = ab.glossary;
  const chapters = await Promise.all(ab.chapterNames.map((n) => readJson<{ paragraphs: unknown[]; new_terms: { source: string; provisional_rendering: string }[] }>(`${runDataDir}/${runId}/chapters/${n}/translation.json`)));
  const reviews: { ch: string; round: number; verdict: string; issues: { severity: string }[]; lint: unknown[] }[] = [];
  for (const n of ab.chapterNames) {
    for (const f of (await readdir(`${runDataDir}/${runId}/chapters/${n}`)).filter((f) => /^review\.r\d+\.json$/.test(f)).sort()) {
      const r = await readJson<{ round: number; verdict: string; issues: { severity: string }[]; lint: unknown[] }>(`${runDataDir}/${runId}/chapters/${n}/${f}`);
      if (r) reviews.push({ ch: n, ...r });
    }
  }

  // One debated term: prefer one with a critique file.
  const debates = await readdir(`${gDir}/debates`).catch(() => [] as string[]);
  interface ProposalFile { rendering: string; banned: string[]; rationale: string; confidence: number }
  interface CritiqueFile { critiques: { proposal: string; strength: string; risk: string }[]; collisions: string[] }
  interface DecisionFile { rendering: string; rationale: string; confidence: number; needs_human: boolean }
  interface Debate { source: string; proposals: Record<string, ProposalFile>; critique: CritiqueFile; decision: DecisionFile | null }
  let debated: Debate | null = null;
  for (const d of debates) {
    const critique = await readJson<CritiqueFile>(`${gDir}/debates/${d}/critique.json`);
    if (!critique) continue;
    const proposals: Record<string, ProposalFile> = {};
    for (const st of ['fidelity', 'readability', 'genre']) {
      const p = await readJson<ProposalFile>(`${gDir}/debates/${d}/proposal.${st}.json`);
      if (p) proposals[st] = p;
    }
    debated = { source: d, proposals, critique, decision: await readJson<DecisionFile>(`${gDir}/debates/${d}/decision.json`) };
    break;
  }

  // Reference eval (eval-only data).
  let refHtml = '';
  try {
    const ref = await referenceGlossary();
    const versions = (await readdir(gDir)).map((f) => Number(f.match(/^glossary\.v(\d+)\.json$/)?.[1] ?? 0)).filter(Boolean).sort();
    const rows: string[] = [];
    for (const v of versions) {
      const gv = await readJson<Glossary>(`${gDir}/glossary.v${v}.json`);
      if (!gv) continue;
      const a = glossaryAgreement(gv.entries, ref);
      const human = gv.entries.filter((e) => e.decided_by === 'human').length;
      rows.push(`<tr><td>v${v}${v === g.version ? ' <span class="tag">used</span>' : ''}</td><td><b>${a.matches}/${a.compared}</b></td><td>${human ? `${human} human resolution(s), made by the reference's author` : 'unaided'}</td><td class="small">${a.mismatches.map((m) => `${esc(m.source)}: ours “${esc(m.ours)}” vs ref ${m.reference.map((r) => `“${esc(r)}”`).join(' / ')}`).join('<br>')}</td></tr>`);
    }
    const refEn = await referenceEnglish();
    const rc = factCounts(refEn);
    const bc = factCounts((await loadBaselineChapters(`${runDataDir}/${runId}`, ab.chapterNames)).map((c) => c.en).join('\n'));
    const fc = factCounts(ab.final.stats.length ? (await Promise.all(ab.chapterNames.map((n) => readFile(`${runDataDir}/${runId}/chapters/${n}/translation.en.txt`, 'utf8')))).join('\n') : '');
    const facts = Object.keys(rc).map((f) => `<tr><td>${esc(f)}</td><td>${rc[f] || '<span class="muted">not stated</span>'}</td><td>${rc[f] ? `${bc[f]}/${rc[f]}` : '—'}</td><td>${rc[f] ? `${fc[f]}/${rc[f]}` : '—'}</td></tr>`).join('');
    refHtml = `
<section><h2>Against the reference translation</h2>
<p class="muted">The answer key (<code>ref/english-reference.md</code>) is read by the eval only; a test asserts that no prompt, activity or workflow module mentions it.</p>
<h3>Glossary agreement (normalized rendering equals any “/” alternate)</h3>
<table><thead><tr><th>glossary</th><th>match</th><th>note</th><th>mismatches</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<h3>Fact ledger (occurrences; total = count in the reference)</h3>
<table><thead><tr><th>fact</th><th>reference</th><th>baseline</th><th>full system</th></tr></thead><tbody>${facts}</tbody></table>
</section>`;
  } catch (e) {
    refHtml = `<section><h2>Against the reference translation</h2><p class="muted">reference not available: ${esc((e as Error).message)}</p></section>`;
  }

  const col = (c: CheckSummary) => ({ cons: pct(c.renderingHits, c.renderingHits + c.bannedHits), banned: `${c.bannedHits} (${c.termsWithBanned})`, cov: c.coverage ? `${c.coverage.covered}/${c.coverage.total}` : 'n/a', cjk: String(c.cjkLeaks), variants: c.meanVariants.toFixed(2) });
  const b = col(ab.base.summary), d = col(ab.draft.summary), f = col(ab.final.summary);
  const C = ab.costs;
  const drift = ab.base.stats.filter((s) => s.bannedHits.length).sort((x, y) => y.bannedHits.reduce((a, c) => a + c.count, 0) - x.bannedHits.reduce((a, c) => a + c.count, 0));
  const glossaryRow = (e: GlossaryEntry) => {
    const cls = e.needs_human ? 'needs-human' : e.decided_by === 'human' ? 'human' : '';
    const al = e.alias_renderings.map((a) => `${esc(a.source)} → ${esc(a.rendering)}`).join(', ');
    return `<tr class="${cls}"><td class="zh">${esc(e.source)}</td><td><b>${esc(e.rendering)}</b>${al ? `<div class="small">${al}</div>` : ''}</td><td>${esc(e.decided_by)}${e.needs_human ? ' <span class="tag warn">needs human</span>' : ''}${e.decided_by === 'human' ? ' <span class="tag ok">resolved</span>' : ''}</td><td class="small">${esc(e.rationale)}${e.banned.length ? `<div class="muted">never: ${esc(e.banned.join(', '))}</div>` : ''}</td></tr>`;
  };
  const resolutions = g.entries.filter((e) => e.decided_by === 'human');
  const reviewRows = reviews.map((r) => `<tr><td>${esc(r.ch)}</td><td>${r.round}</td><td>${esc(r.verdict)}</td><td>${r.issues.filter((i) => i.severity === 'critical').length} / ${r.issues.filter((i) => i.severity === 'major').length} / ${r.issues.filter((i) => i.severity === 'minor').length}</td><td>${r.lint.length}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>concord report — ${esc(runId)}</title>
<style>
:root{--ink:#1a1a1a;--muted:#6b6b6b;--line:#e3e3e3;--bg:#fcfcfa;--accent:#0b5fff;--warn:#b35c00;--ok:#1b7f3b;--hl:#fff6d6;--hl2:#e8f5ec}
html{font-size:20px}body{margin:0 auto;max-width:1180px;padding:32px 24px 80px;font:1rem/1.5 Georgia,"Times New Roman",serif;color:var(--ink);background:var(--bg)}
h1{font-size:2.2rem;margin:.2em 0}h2{font-size:1.6rem;margin:2em 0 .5em;border-bottom:2px solid var(--ink);padding-bottom:.2em}h3{font-size:1.2rem;margin:1.4em 0 .4em}
table{border-collapse:collapse;width:100%;margin:.6em 0 1.2em;font-size:.92rem}th,td{text-align:left;vertical-align:top;padding:.45em .6em;border-bottom:1px solid var(--line)}th{font-weight:600;background:#f1f1ee}
.zh{font-size:1.1rem;white-space:nowrap}.small{font-size:.85rem}.muted{color:var(--muted)}.tag{font:.72rem/1.4 system-ui,sans-serif;border:1px solid currentColor;border-radius:999px;padding:0 .5em;vertical-align:middle;color:var(--accent)}.tag.warn{color:var(--warn)}.tag.ok{color:var(--ok)}
tr.needs-human td{background:var(--hl)}tr.human td{background:var(--hl2)}
.big{font-size:2.6rem;font-weight:700;line-height:1.1}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin:1em 0}.card{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:#fff}
blockquote{margin:.6em 0;padding:.6em 1em;border-left:4px solid var(--line);background:#fff}code{font-size:.9em;background:#f1f1ee;padding:0 .3em;border-radius:4px}
</style></head><body>
<header><p class="muted">concord · shared-brain translation team · run <code>${esc(runId)}</code> · glossary <code>${esc(ab.glossaryPath.split('/').pop())}</code> from run <code>${esc(ab.glossaryRunId)}</code></p>
<h1>One glossary, three chapters, three models</h1>
<p>Nemotron decides what the book's words are. DeepSeek writes. GLM checks. Every decision below was made by the agents, except the ones marked <span class="tag ok">resolved</span>, which a human answered.</p></header>

<section><div class="grid">
<div class="card"><div class="muted">term consistency, one-prompt baseline</div><div class="big">${b.cons}</div><div class="small">${b.banned} banned-variant hits (terms)</div></div>
<div class="card"><div class="muted">term consistency, full system before review</div><div class="big">${d.cons}</div><div class="small">${d.banned} banned-variant hits · coverage ${d.cov}</div></div>
<div class="card"><div class="muted">term consistency, full system after review</div><div class="big">${f.cons}</div><div class="small">${f.banned} banned-variant hits · coverage ${f.cov}</div></div>
<div class="card"><div class="muted">total cost (baseline → full)</div><div class="big">${usd(C.baseline.usd)} → ${usd(C.translator.usd + C.reviewer.usd + C.reviser.usd + C.glossary.usd)}</div><div class="small">glossary ${usd(C.glossary.usd)} (${C.glossary.calls} calls) · translation ${usd(C.translator.usd)} · review/revise ${usd(C.reviewer.usd + C.reviser.usd)}</div></div>
</div></section>

<section><h2>Ablation</h2>
<table><thead><tr><th>metric</th><th>baseline (1 prompt)</th><th>full, before review</th><th>full, after review</th></tr></thead><tbody>
<tr><td>term consistency (chosen / chosen + banned)</td><td>${b.cons}</td><td>${d.cons}</td><td><b>${f.cons}</b></td></tr>
<tr><td>banned-variant hits (terms affected)</td><td>${b.banned}</td><td>${d.banned}</td><td>${f.banned}</td></tr>
<tr><td>mean distinct renderings per term</td><td>${b.variants}</td><td>${d.variants}</td><td>${f.variants}</td></tr>
<tr><td>paragraph term coverage</td><td class="muted">n/a (no paragraph ids)</td><td>${d.cov}</td><td>${f.cov}</td></tr>
<tr><td>leftover Chinese</td><td>${b.cjk}</td><td>${d.cjk}</td><td>${f.cjk}</td></tr>
<tr><td>translation cost</td><td>${usd(C.baseline.usd)}</td><td>${usd(C.translator.usd)}</td><td>+ ${usd(C.reviewer.usd + C.reviser.usd)} review/revise (${C.reviewer.calls} reviews, ${C.reviser.calls} revisions)</td></tr>
<tr><td>cached-token rate on translation</td><td>${pct(C.baseline.cached, C.baseline.prompt)}</td><td>${pct(C.translator.cached, C.translator.prompt)}</td><td>${pct(C.translator.cached + C.reviser.cached, C.translator.prompt + C.reviser.prompt)}</td></tr>
</tbody></table>
<p class="small muted">Banned variants excluded as ambiguous (also another entry's rendering): ${esc(ambiguousBannedVariants(g.entries).map((x) => `${x.source} “${x.variant}” (= ${x.conflictsWith})`).join(', ') || 'none')}.</p>
<p class="small muted">Consistency counts the chosen rendering against <em>known banned variants</em> only. The after-review column is enforced by the loop (approval requires zero lint violations), so the before-review column and the baseline drift are the independent evidence. The same DeepSeek model wrote every column.</p>
<h3>Where the one-prompt baseline drifted</h3>
<table><thead><tr><th>term</th><th>glossary rendering</th><th>baseline wrote</th></tr></thead><tbody>
${drift.map((s) => `<tr><td class="zh">${esc(s.source)}</td><td>${esc(g.entries.find((e) => e.source === s.source)?.rendering)}</td><td>${s.bannedHits.map((h) => `“${esc(h.variant)}” ×${h.count}`).join(', ')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">none</td></tr>'}
</tbody></table></section>

<section><h2>Review loop</h2>
<table><thead><tr><th>chapter</th><th>round</th><th>verdict</th><th>issues critical / major / minor</th><th>code lint violations</th></tr></thead><tbody>${reviewRows || '<tr><td colspan="5" class="muted">no reviews in this run</td></tr>'}</tbody></table>
<p class="small muted">Approval requires the reviewer's verdict <em>and</em> zero lint violations. New terms reported by the translator: ${chapters.flatMap((c) => c?.new_terms ?? []).map((t) => `${esc(t.source)} → ${esc(t.provisional_rendering)}`).join(', ') || 'none'}.</p></section>

<section><h2>Glossary ${esc(ab.glossaryPath.split('/').pop()?.replace('glossary.', '').replace('.json', ''))} <span class="small muted">(${g.entries.length} entries; ${g.entries.filter((e) => e.decided_by === 'agreement').length} by agreement, ${g.entries.filter((e) => e.decided_by === 'terminologist').length} debated, ${resolutions.length} human-resolved, ${g.entries.filter((e) => e.needs_human).length} still need a human)</span></h2>
<table><thead><tr><th>source</th><th>rendering</th><th>decided by</th><th>rationale</th></tr></thead><tbody>${g.entries.map(glossaryRow).join('')}</tbody></table></section>

${debated ? `<section><h2>One debated term: ${esc(debated.source)}</h2>
<h3>Three blind proposals</h3>
<table><thead><tr><th>stance</th><th>rendering</th><th>would ban</th><th>rationale</th></tr></thead><tbody>${Object.entries(debated.proposals).map(([st, p]) => `<tr><td>${esc(st)}</td><td><b>${esc(p.rendering)}</b></td><td class="small">${esc(p.banned.join(', '))}</td><td class="small">${esc(p.rationale)}</td></tr>`).join('')}</tbody></table>
<h3>Critic</h3>
<table><thead><tr><th>proposal</th><th>strongest point</th><th>biggest risk</th></tr></thead><tbody>${debated.critique.critiques.map((c) => `<tr><td>${esc(c.proposal)}</td><td class="small">${esc(c.strength)}</td><td class="small">${esc(c.risk)}</td></tr>`).join('')}</tbody></table>
${debated.critique.collisions.length ? `<p class="small">Collisions noted: ${esc(debated.critique.collisions.join('; '))}</p>` : ''}
<h3>Terminologist</h3>
${debated.decision ? `<blockquote><b>${esc(debated.decision.rendering)}</b> (confidence ${debated.decision.confidence}${debated.decision.needs_human ? ', flagged for a human' : ''})<br>${esc(debated.decision.rationale)}</blockquote>` : '<p class="muted">no decision file</p>'}
</section>` : ''}

<section><h2>Human resolutions</h2>
${resolutions.length ? `<table><thead><tr><th>source</th><th>now</th><th>what it answered</th><th>code notes</th></tr></thead><tbody>${resolutions.map((e) => `<tr class="human"><td class="zh">${esc(e.source)}</td><td><b>${esc(e.rendering)}</b></td><td class="small">${esc(e.resolved_from)}</td><td class="small">${e.code_notes.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">none</p>'}
</section>

${refHtml}

<footer class="small muted"><p>Generated from <code>run-data/${esc(runId)}</code> and <code>run-data/${esc(ab.glossaryRunId)}</code> only. Models: Nemotron 3 Super (glossary decisions), Nemotron 3.5 Lightning (extraction), DeepSeek V4.1 Flash (tagging, translation), GLM-5.3-Flash (review). Orchestration: Temporal.</p></footer>
</body></html>`;
}

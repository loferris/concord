// Incremental mode: a new chapter joins an existing glossary. Existing entries are frozen; only new terms are
// grouped and debated. Everything here is additive to the batch path.
import { MODELS, PRICING } from '../config';
import { chatJson } from '../llm';
import { grouperPrompt, renderTaggedParagraph } from '../prompts';
import { AliasGroupsSchema, type Extraction, type Glossary, type GlossaryEntry, type TaggedChapter, type Usage } from '../schemas';
import { nestedTermViolations, renderingCollisions } from '../checks';
import { normRaw } from '../normalize';
import { readText, recordUsage, runDir, writeJsonAtomic } from './io';
import { attemptSeed, modelForAttempt, withHeartbeat } from './common';
import { formatAddressForms, type AddressForm } from './tag';
import type { EntityRecord } from './group';
import { citedPrecedents } from './glossary';

export interface GroupIncrementalInput {
  runId: string;
  chapterName: string;
  extractionPath: string;
  taggedPath: string;
  addressFormsPath: string;
  /** Previous glossary (null for the first chapter). */
  glossaryPath: string | null;
  /** entities.json from the previous step (contexts for existing entities), or null. */
  entitiesPath: string | null;
}
export interface GroupIncrementalOutput {
  entitiesPath: string;
  known: string[];
  newEntities: string[];
  newAliases: { alias: string; entity: string; used_by: string }[];
  skipped: string[];
  usage: Usage;
  calls: number;
}

type TaggedFile = TaggedChapter & { chapter: string };
function snippets(source: string, t: TaggedFile, max = 3): string[] {
  const out: string[] = [];
  for (const p of t.paragraphs) {
    if (!p.segments.map((s) => s.text).join('').includes(source)) continue;
    out.push(`[${t.chapter}.${p.id}] ${renderTaggedParagraph(p)}`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 1. Exact-match the chapter's items against existing sources and aliases: known items are skipped.
 * 2. For each new item, ONE grouper call that sees the existing entities: alias of X, or a new entity.
 *    A wrong merge is worse than a miss: an alias assignment is accepted only if the target exists and the
 *    address-form table does not contradict it.
 */
export async function groupIncremental(input: GroupIncrementalInput): Promise<GroupIncrementalOutput> {
  return withHeartbeat(async () => {
    const extraction = JSON.parse(await readText(input.extractionPath)) as Extraction;
    const tagged = JSON.parse(await readText(input.taggedPath)) as TaggedFile;
    const forms = JSON.parse(await readText(input.addressFormsPath)) as AddressForm[];
    const glossary: GlossaryEntry[] = input.glossaryPath ? (JSON.parse(await readText(input.glossaryPath)) as Glossary).entries : [];
    const prevEntities: EntityRecord[] = input.entitiesPath ? (JSON.parse(await readText(input.entitiesPath)) as { entities: EntityRecord[] }).entities : [];

    const knownSources = new Set<string>();
    for (const e of glossary) {
      knownSources.add(e.source);
      for (const a of e.alias_renderings) knownSources.add(a.source);
    }
    const known: string[] = [];
    const candidates = extraction.items.filter((it) => {
      if (knownSources.has(it.source)) {
        known.push(it.source);
        return false;
      }
      return it.needs_fixed_rendering;
    });
    const skipped = extraction.items.filter((it) => !knownSources.has(it.source) && !it.needs_fixed_rendering).map((it) => it.source);

    const entities: EntityRecord[] = prevEntities.map((e) => ({ ...e, aliases: [...e.aliases] }));
    const byCanonical = new Map(entities.map((e) => [e.canonical_source, e]));
    // Existing glossary entries that have no entity record (e.g. first chapter had none): synthesize.
    for (const g of glossary) {
      if (!byCanonical.has(g.source)) {
        const rec: EntityRecord = { canonical_source: g.source, aliases: g.aliases, type: g.type, evidence: 'from glossary', contexts: [] };
        entities.push(rec);
        byCanonical.set(g.source, rec);
      }
    }
    const existingBlock = entities
      .map((e) => `ITEM: ${e.canonical_source} (${e.type}) [ALREADY IN GLOSSARY${e.aliases.length ? `; aliases: ${e.aliases.map((a) => a.source).join(', ')}` : ''}]\n  contexts:\n${(e.contexts.slice(0, 2).map((c) => `    ${c}`).join('\n')) || '    (earlier chapters)'}`)
      .join('\n\n');

    const newEntities: string[] = [];
    const newAliases: GroupIncrementalOutput['newAliases'] = [];
    let usage: Usage = { model: MODELS.smart, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
    let calls = 0;
    for (const it of candidates) {
      const ctx = snippets(it.source, tagged);
      const itemBlock = `ITEM: ${it.source} (${it.type})${it.refers_to ? ` refers_to=${it.refers_to}` : ''} [NEW in chapter ${input.chapterName}]\n  reason: ${it.reason}\n  contexts:\n${ctx.map((c) => `    ${c}`).join('\n') || '    (none found)'}`;
      let decision: { alias_of: string | null; used_by: string; kind: 'nickname' | 'address' | 'title' | 'variant'; evidence: string } = { alias_of: null, used_by: '', kind: 'variant', evidence: 'new entity (no grouping call)' };
      if (entities.length) {
        const prompt = grouperPrompt(`${itemBlock}\n\n${existingBlock}`, formatAddressForms(forms));
        const res = await chatJson({ model: modelForAttempt(MODELS.smart), ...prompt, schemaName: 'alias_groups', maxTokens: 2048, seed: attemptSeed(), enableThinking: false }, AliasGroupsSchema);
        calls++;
        usage = { ...usage, prompt_tokens: usage.prompt_tokens + res.usage.prompt_tokens, completion_tokens: usage.completion_tokens + res.usage.completion_tokens, cached_tokens: (usage.cached_tokens ?? 0) + (res.usage.cached_tokens ?? 0) };
        await recordUsage(input.runId, 'grouper', `${input.chapterName}:${it.source}`, res.usage);
        const host = res.data.entities.find((e) => e.canonical_source !== it.source && e.aliases.some((a) => a.source === it.source));
        if (host && byCanonical.has(host.canonical_source)) {
          const a = host.aliases.find((x) => x.source === it.source)!;
          // Contradiction check: if the table shows this form addressing someone else, keep it separate.
          const rows = forms.filter((f) => f.form === it.source && f.addressee !== 'unknown');
          const contradicts = rows.length && rows.sort((x, y) => y.count - x.count)[0].addressee !== host.canonical_source && byCanonical.has(rows[0].addressee);
          if (!contradicts) decision = { alias_of: host.canonical_source, used_by: a.used_by, kind: a.kind, evidence: host.evidence };
          else decision.evidence = `grouper proposed alias of ${host.canonical_source} but the address table says it addresses ${rows[0].addressee}; kept separate`;
        } else {
          const own = res.data.entities.find((e) => e.canonical_source === it.source);
          decision.evidence = own?.evidence ?? res.data.kept_separate.find((k) => k.sources.includes(it.source))?.reason ?? 'grouper returned it as its own entity';
        }
      }
      if (decision.alias_of) {
        const host = byCanonical.get(decision.alias_of)!;
        host.aliases.push({ source: it.source, kind: decision.kind, used_by: decision.used_by });
        for (const c of ctx) if (!host.contexts.includes(c)) host.contexts.push(c);
        newAliases.push({ alias: it.source, entity: decision.alias_of, used_by: decision.used_by });
      } else {
        const rec: EntityRecord = { canonical_source: it.source, aliases: [], type: it.type, evidence: decision.evidence, contexts: ctx };
        entities.push(rec);
        byCanonical.set(it.source, rec);
        newEntities.push(it.source);
      }
    }
    const dir = runDir(input.runId, 'glossary', 'incremental', input.chapterName);
    const entitiesPath = `${dir}/entities.json`;
    await writeJsonAtomic(entitiesPath, { entities, known, newEntities, newAliases, skipped });
    console.log(`[incremental] ${input.chapterName}: known ${known.length}, new entities ${newEntities.length} (${newEntities.join(', ') || '—'}), new aliases ${newAliases.map((a) => `${a.alias}→${a.entity}`).join(', ') || '—'}, skipped ${skipped.length}`);
    return { entitiesPath, known, newEntities, newAliases, skipped, usage, calls };
  });
}

// ---- Version writer with changelog ----------------------------------------------------------------
export interface WriteVersionInput {
  runId: string;
  chapterName: string;
  previousGlossaryPath: string | null;
  version: number;
  newEntries: GlossaryEntry[];
  newAliases: { alias: string; entity: string; used_by: string }[];
  /** alias renderings decided for new aliases of existing entities */
  aliasRenderings: { entity: string; source: string; rendering: string }[];
  debates: number;
  /** ISO time the step started; cost is summed from usage.jsonl rows at or after it. */
  stepStartedAt: string;
}
export interface ChangelogEntry {
  version: number;
  chapter: string;
  entitiesTotal: number;
  newEntities: string[];
  newAliases: { alias: string; entity: string }[];
  debates: number;
  precedentsCited: string[];
  calls: number;
  costUsd: number;
}
export async function writeGlossaryVersion(input: WriteVersionInput): Promise<{ glossaryPath: string; changelog: ChangelogEntry }> {
  const prev: Glossary | null = input.previousGlossaryPath ? (JSON.parse(await readText(input.previousGlossaryPath)) as Glossary) : null;
  // Frozen-entry rule: existing entries are copied unchanged; only new aliases are appended to them.
  const entries: GlossaryEntry[] = (prev?.entries ?? []).map((e) => ({ ...e, aliases: [...e.aliases], alias_renderings: [...e.alias_renderings], code_notes: [...e.code_notes] }));
  for (const a of input.newAliases) {
    const host = entries.find((e) => e.source === a.entity);
    if (!host) continue;
    if (!host.aliases.some((x) => x.source === a.alias)) host.aliases.push({ source: a.alias, kind: 'address', used_by: a.used_by });
    const r = input.aliasRenderings.find((x) => x.entity === a.entity && x.source === a.alias);
    if (r && !host.alias_renderings.some((x) => x.source === a.alias)) host.alias_renderings.push({ source: a.alias, rendering: r.rendering });
    host.code_notes.push(`v${input.version}: alias ${a.alias} added from chapter ${input.chapterName}${r ? ` → ${r.rendering}` : ''}`);
  }
  const existingRenderings = new Set(entries.flatMap((e) => [normRaw(e.rendering), ...e.alias_renderings.map((x) => normRaw(x.rendering))]));
  for (const n of input.newEntries) {
    const e = { ...n, code_notes: [...n.code_notes] };
    if (existingRenderings.has(normRaw(e.rendering))) {
      e.needs_human = true;
      e.needs_human_reason = [e.needs_human_reason, `rendering collides with a frozen entry`].filter(Boolean).join('; ');
    }
    entries.push(e);
  }
  entries.sort((a, b) => a.source.localeCompare(b.source, 'zh'));
  const nested = nestedTermViolations(entries);
  for (const v of nested) {
    const e = entries.find((x) => x.source === v.source)!;
    if (prev?.entries.some((p) => p.source === v.source)) continue; // frozen entries are never changed here
    e.needs_human = true;
    e.needs_human_reason = [e.needs_human_reason, `nested-term rule: must contain "${v.requiredRendering}" (${v.within})`].filter(Boolean).join('; ');
  }
  const collisions = renderingCollisions(entries);
  const glossaryPath = runDir(input.runId, 'glossary', `glossary.v${input.version}.json`);
  await writeJsonAtomic(glossaryPath, { version: input.version, runId: input.runId, entries } satisfies Glossary);

  // Changelog: cost from usage.jsonl rows since the step started.
  let calls = 0, costUsd = 0;
  try {
    for (const line of (await readText(runDir(input.runId, 'usage.jsonl'))).split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { ts: string; model: string; prompt_tokens: number; completion_tokens: number; cached_tokens: number | null };
      if (r.ts < input.stepStartedAt) continue;
      calls++;
      const p = PRICING[r.model.replace(/^fake:/, '')] ?? { prompt: 0, completion: 0, cached: 0 };
      const c = r.cached_tokens ?? 0;
      costUsd += ((r.prompt_tokens - c) * p.prompt + c * p.cached + r.completion_tokens * p.completion) / 1e6;
    }
  } catch {
    /* no usage yet */
  }
  const gPrev: Glossary = prev ?? { version: 0, runId: input.runId, entries: [] };
  const precedentsCited = Array.from(new Set(input.newEntries.flatMap((e) => citedPrecedents(e.rationale, gPrev))));
  const changelog: ChangelogEntry = { version: input.version, chapter: input.chapterName, entitiesTotal: entries.length, newEntities: input.newEntries.map((e) => e.source), newAliases: input.newAliases.map((a) => ({ alias: a.alias, entity: a.entity })), debates: input.debates, precedentsCited, calls, costUsd: Math.round(costUsd * 1e4) / 1e4 };
  const logPath = runDir(input.runId, 'glossary', 'changelog.json');
  let log: ChangelogEntry[] = [];
  try {
    log = JSON.parse(await readText(logPath)) as ChangelogEntry[];
  } catch {
    /* first version */
  }
  await writeJsonAtomic(logPath, [...log.filter((l) => l.version !== input.version), changelog]);
  if (collisions.length) console.log(`[incremental] v${input.version}: rendering collisions: ${collisions.map((c) => `${c.rendering} ← ${c.sources.join(', ')}`).join('; ')}`);
  return { glossaryPath, changelog };
}

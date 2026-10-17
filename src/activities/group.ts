import { MODELS } from '../config';
import { chatJson } from '../llm';
import { grouperPrompt, renderTaggedParagraph } from '../prompts';
import { AliasGroupsSchema, type Extraction, type TaggedChapter, type Usage, type Entity } from '../schemas';
import { ApplicationFailure } from '@temporalio/common';
import { readText, recordUsage, runDir, writeJsonAtomic } from './io';
import { attemptSeed, modelForAttempt, withHeartbeat } from './common';
import { formatAddressForms, type AddressForm } from './tag';

export interface GroupAliasesInput {
  runId: string;
  extractionPath: string;
  taggedPaths: string[];
  addressFormsPaths: string[];
}
export interface GroupAliasesOutput {
  entitiesPath: string;
  addressFormsPath: string;
  entityCount: number;
  keptSeparateCount: number;
  usage: Usage;
}

/** Entity plus the contexts the debate will need. Written to run-data so proposers can read it by source. */
export interface EntityRecord extends Entity {
  contexts: string[];
}

type TaggedFile = TaggedChapter & { chapter: string };

function snippetsFor(source: string, tagged: TaggedFile[], max: number): string[] {
  const out: string[] = [];
  for (const t of tagged) {
    for (const p of t.paragraphs) {
      const plain = p.segments.map((s) => s.text).join('');
      if (!plain.includes(source)) continue;
      out.push(`[${t.chapter}.${p.id}] ${renderTaggedParagraph(p)}`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export async function groupAliases(input: GroupAliasesInput): Promise<GroupAliasesOutput> {
  return withHeartbeat(async () => {
    const extraction = JSON.parse(await readText(input.extractionPath)) as Extraction;
    const tagged: TaggedFile[] = [];
    for (const p of input.taggedPaths) tagged.push(JSON.parse(await readText(p)) as TaggedFile);
    const forms: AddressForm[] = [];
    for (const p of input.addressFormsPaths) forms.push(...(JSON.parse(await readText(p)) as AddressForm[]));
    // Merge the per-chapter tables into one book-wide table.
    const merged = new Map<string, AddressForm>();
    for (const f of forms) {
      const k = `${f.speaker}\u0000${f.addressee}\u0000${f.form}`;
      const cur = merged.get(k);
      if (cur) {
        cur.count += f.count;
        cur.paragraph_ids.push(...f.paragraph_ids);
      } else merged.set(k, { ...f, paragraph_ids: [...f.paragraph_ids] });
    }
    const bookForms = Array.from(merged.values()).sort((a, b) => b.count - a.count);

    const itemsBlock = extraction.items
      .map((it) => {
        const ctx = snippetsFor(it.source, tagged, 3);
        return `ITEM: ${it.source} (${it.type})${it.refers_to ? ` refers_to=${it.refers_to}` : ''} needs_fixed_rendering=${it.needs_fixed_rendering}\n  reason: ${it.reason}\n  paragraphs: ${it.paragraph_ids.join(', ')}\n  contexts:\n${ctx.map((c) => `    ${c}`).join('\n') || '    (none found)'}`;
      })
      .join('\n\n');
    const prompt = grouperPrompt(itemsBlock, formatAddressForms(bookForms));
    const res = await chatJson(
      { model: modelForAttempt(MODELS.smart), ...prompt, schemaName: 'alias_groups', maxTokens: 4096, seed: attemptSeed(), enableThinking: false },
      AliasGroupsSchema,
    );

    // Reconcile with the tagger's address-form table (the strongest evidence): a form that the table shows
    // as "X → Y: form" is how X addresses Y, so it belongs to Y's entity, not X's. Models sometimes attach it
    // to the speaker. Deterministic fix, logged.
    // Code checks: every source the grouper names must be an extracted item (no invented terms), and a
    // source may belong to exactly one entity (first wins). Self-aliases and empty sources are dropped.
    const known = new Set(extraction.items.map((it) => it.source));
    const unknown = new Set<string>();
    const claimed = new Set<string>();
    const codeNotes: string[] = [];
    const entities: typeof res.data.entities = [];
    for (const e of res.data.entities) {
      const canonical = e.canonical_source.trim();
      if (!known.has(canonical)) {
        unknown.add(canonical);
        continue;
      }
      if (claimed.has(canonical)) {
        codeNotes.push(`dropped duplicate entity ${canonical}`);
        continue;
      }
      claimed.add(canonical);
      const aliases = [] as typeof e.aliases;
      for (const a of e.aliases) {
        const src = a.source.trim();
        if (!src || src === canonical) continue;
        if (!known.has(src)) {
          unknown.add(src);
          continue;
        }
        if (claimed.has(src)) {
          codeNotes.push(`alias ${src} already belongs to another entity; dropped from ${canonical}`);
          continue;
        }
        claimed.add(src);
        aliases.push({ ...a, source: src });
      }
      entities.push({ ...e, canonical_source: canonical, aliases });
    }
    if (unknown.size) {
      throw ApplicationFailure.create({ type: 'GrouperUnknownSource', message: `grouper named sources that were not extracted: ${Array.from(unknown).join(', ')}`, nonRetryable: false });
    }
    if (codeNotes.length) console.log(`[group] ${codeNotes.join('; ')}`);
    const byCanonical = new Map(entities.map((e) => [e.canonical_source, e]));
    const moves: string[] = [];
    for (const e of entities) {
      for (const a of [...e.aliases]) {
        const rows = bookForms.filter((f) => f.form === a.source && f.addressee !== 'unknown');
        if (!rows.length) continue;
        const target = rows.sort((x, y) => y.count - x.count)[0];
        if (target.addressee === e.canonical_source) continue;
        const dest = byCanonical.get(target.addressee);
        if (!dest) continue;
        e.aliases.splice(e.aliases.indexOf(a), 1);
        if (!dest.aliases.some((x) => x.source === a.source)) dest.aliases.push({ ...a, used_by: target.speaker });
        moves.push(`${a.source}: ${e.canonical_source} → ${dest.canonical_source} (table: ${target.speaker} → ${target.addressee}: ${a.source} ×${target.count})`);
      }
    }
    if (moves.length) console.log(`[group] reassigned ${moves.length} alias(es) by address table:\n  ${moves.join('\n  ')}`);

    // Completeness: every extracted item that needs a fixed rendering must end up in exactly one entity.
    // Models sometimes return only the groups that have aliases; the rest become singleton entities.
    const placed = new Set<string>();
    for (const e of entities) {
      placed.add(e.canonical_source);
      for (const a of e.aliases) placed.add(a.source);
    }
    const singletons: string[] = [];
    const skipped: string[] = [];
    for (const it of extraction.items) {
      if (placed.has(it.source)) continue;
      if (!it.needs_fixed_rendering) {
        skipped.push(it.source);
        continue;
      }
      entities.push({ canonical_source: it.source, aliases: [], type: it.type, evidence: `singleton added by code: extracted as ${it.type} (${it.reason}); not grouped by the model` });
      placed.add(it.source);
      singletons.push(it.source);
    }
    if (singletons.length) codeNotes.push(`added ${singletons.length} singleton entities not returned by the grouper: ${singletons.join(', ')}`);
    if (skipped.length) codeNotes.push(`skipped ${skipped.length} unplaced items marked needs_fixed_rendering=false: ${skipped.join(', ')}`);
    if (singletons.length || skipped.length) console.log(`[group] ${codeNotes.slice(-2).join('\n[group] ')}`);

    const records: EntityRecord[] = entities.map((e) => {
      const sources = [e.canonical_source, ...e.aliases.map((a) => a.source)];
      const contexts: string[] = [];
      for (const s of sources) for (const c of snippetsFor(s, tagged, 3)) if (!contexts.includes(c)) contexts.push(c);
      return { ...e, contexts: contexts.slice(0, 6) };
    });
    const dir = runDir(input.runId, 'glossary');
    const entitiesPath = `${dir}/entities.json`;
    const addressFormsPath = `${dir}/address-forms.json`;
    await writeJsonAtomic(entitiesPath, { entities: records, kept_separate: res.data.kept_separate, alias_moves: moves, code_notes: codeNotes, model_output: res.data });
    await writeJsonAtomic(addressFormsPath, bookForms);
    await recordUsage(input.runId, 'grouper', 'book', res.usage);
    return { entitiesPath, addressFormsPath, entityCount: records.length, keptSeparateCount: res.data.kept_separate.length, usage: res.usage };
  });
}

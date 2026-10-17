import { readText } from './io';
import type { EntityRecord } from './group';
import type { TermType } from './types';

/** Small activity so the workflow can learn entity sources without reading files itself. */
export async function listEntities(entitiesPath: string): Promise<{ source: string; type: TermType }[]> {
  const { entities } = JSON.parse(await readText(entitiesPath)) as { entities: EntityRecord[] };
  return entities.map((e) => ({ source: e.canonical_source, type: e.type }));
}

export async function listEntityAliases(input: { entitiesPath: string; source: string }): Promise<{ source: string; kind: 'nickname' | 'address' | 'title' | 'variant'; used_by: string }[]> {
  const { entities } = JSON.parse(await readText(input.entitiesPath)) as { entities: EntityRecord[] };
  const e = entities.find((x) => x.canonical_source === input.source);
  return e ? e.aliases : [];
}

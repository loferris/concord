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

import { copyFile as fsCopy, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Glossary } from '../schemas';

export async function listGlossarySources(glossaryPath: string): Promise<string[]> {
  const g = JSON.parse(await readText(glossaryPath)) as Glossary;
  return g.entries.flatMap((e) => [e.source, ...e.alias_renderings.map((a) => a.source)]);
}
export async function copyFile(input: { from: string; to: string }): Promise<void> {
  await mkdir(dirname(input.to), { recursive: true });
  await fsCopy(input.from, input.to);
}

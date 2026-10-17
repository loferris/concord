// Deterministic only: no I/O, no OpenAI import. Text never enters history; activities pass paths.
import { proxyActivities, executeChild } from '@temporalio/workflow';
import type * as activities from './activities';
import { TASK_QUEUES } from './config';
import type { GlossaryEntry, Proposal, Usage } from './schemas';
import type { Stance } from './prompts';

const retry = { initialInterval: '2s', backoffCoefficient: 2, maximumInterval: '60s', maximumAttempts: 6 };

const fast = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.fast, startToCloseTimeout: '10 minutes', heartbeatTimeout: '15 seconds', retry });
const smart = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.smart, startToCloseTimeout: '10 minutes', heartbeatTimeout: '15 seconds', retry });
// File-only activities: quick, no heartbeat needed.
const local = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.smart, startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } });

// ---------------------------------------------------------------------------------------------
export interface ChapterWorkflowInput {
  runId: string;
  chapterPath: string;
  glossaryPath?: string;
}
export interface ChapterWorkflowResult {
  chapterName: string;
  paragraphCount: number;
  translationPath: string;
  englishPath: string;
  usage: Usage;
  status: 'translated';
}

/** Milestone 1: translate only. Later: translate -> term lint -> review -> revise (<=3) -> approve or flag. */
export async function ChapterWorkflow(input: ChapterWorkflowInput): Promise<ChapterWorkflowResult> {
  const t = await fast.translateChapter(input);
  return { ...t, status: 'translated' };
}

// ---------------------------------------------------------------------------------------------
export interface DebateWorkflowInput {
  runId: string;
  entitiesPath: string;
  policiesPath: string;
  source: string;
  type: GlossaryEntry['type'];
  /** Other entity sources, for collision awareness (debates run in parallel). */
  otherSources: string[];
}
export interface DebateWorkflowResult {
  entry: GlossaryEntry;
  calls: number;
}

const STANCES: Stance[] = ['fidelity', 'readability', 'genre'];
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** One contested-or-not term: three blind proposers; agreement freezes, otherwise critic → terminologist. */
export async function DebateWorkflow(input: DebateWorkflowInput): Promise<DebateWorkflowResult> {
  const base = { runId: input.runId, entitiesPath: input.entitiesPath, policiesPath: input.policiesPath, source: input.source };
  const proposals = await Promise.all(STANCES.map((stance) => smart.propose({ ...base, stance })));
  const ps: Proposal[] = proposals.map((p) => p.proposal);
  const renderings = ps.map((p) => norm(p.rendering));
  // We need the entity's aliases for the entry; pull them from the first proposal's alias list (sources).
  const aliasesFromEntity = await local.listEntityAliases({ entitiesPath: input.entitiesPath, source: input.source });

  if (renderings.every((r) => r === renderings[0])) {
    const banned = Array.from(new Set(ps.flatMap((p) => p.banned)));
    // Alias renderings: take the first proposal's, filling gaps from the others.
    const alias_renderings = aliasesFromEntity.map((a) => {
      const hit = ps.map((p) => p.alias_renderings.find((x) => x.source === a.source)).find(Boolean);
      return { source: a.source, rendering: hit?.rendering ?? ps[0].rendering };
    });
    const entry: GlossaryEntry = {
      source: input.source,
      type: input.type,
      rendering: ps[0].rendering.trim(),
      aliases: aliasesFromEntity,
      alias_renderings,
      banned,
      context_rules: [],
      decided_by: 'agreement',
      rationale: ps[0].rationale,
      confidence: Math.min(...ps.map((p) => p.confidence)),
      needs_human: false,
      needs_human_reason: null,
    };
    return { entry, calls: 3 };
  }

  const { critique } = await smart.critique({ ...base, proposals: ps, otherSources: input.otherSources });
  const { decision } = await smart.decide({ ...base, proposals: ps, critique, otherSources: input.otherSources });
  const entry: GlossaryEntry = {
    source: input.source,
    type: input.type,
    rendering: decision.rendering.trim(),
    aliases: aliasesFromEntity,
    alias_renderings: decision.alias_renderings,
    banned: decision.banned,
    context_rules: decision.context_rules,
    decided_by: 'terminologist',
    rationale: decision.rationale,
    confidence: decision.confidence,
    needs_human: decision.needs_human,
    needs_human_reason: decision.needs_human ? decision.rationale : null,
  };
  return { entry, calls: 5 };
}

// ---------------------------------------------------------------------------------------------
export interface BookWorkflowInput {
  runId: string;
  chapterPaths: string[];
  /** Stop early for inspection: 'group' = after tag/extract/group (milestone 2a). */
  stopAfter?: 'group' | 'glossary';
}
export interface BookWorkflowResult {
  runId: string;
  tagged: { chapterName: string; paragraphCount: number; segmentCount: number }[];
  extraction: { candidateCount: number; itemCount: number; rejectedCount: number };
  grouping: { entityCount: number; keptSeparateCount: number; entitiesPath: string; addressFormsPath: string };
  policiesPath?: string;
  glossaryPath?: string;
  glossary?: { entries: number; byAgreement: number; debated: number; needsHuman: number; modelCalls: number };
  status: 'structured' | 'glossary-frozen';
}

export async function BookWorkflow(input: BookWorkflowInput): Promise<BookWorkflowResult> {
  // 1. Tag every chapter in parallel (smart queue limits concurrency).
  const tagged = await Promise.all(input.chapterPaths.map((chapterPath) => smart.tagChapter({ runId: input.runId, chapterPath })));
  // 2. Extract terms from the whole book (one Lightning call) with code candidates.
  const extraction = await fast.extractTerms({ runId: input.runId, chapterPaths: input.chapterPaths });
  // 3. Group aliases into entities, using tagged contexts + address-form table.
  const grouping = await smart.groupAliases({
    runId: input.runId,
    extractionPath: extraction.extractionPath,
    taggedPaths: tagged.map((t) => t.taggedPath),
    addressFormsPaths: tagged.map((t) => t.addressFormsPath),
  });
  const partial: BookWorkflowResult = {
    runId: input.runId,
    tagged: tagged.map((t) => ({ chapterName: t.chapterName, paragraphCount: t.paragraphCount, segmentCount: t.segmentCount })),
    extraction: { candidateCount: extraction.candidateCount, itemCount: extraction.itemCount, rejectedCount: extraction.rejectedCount },
    grouping: { entityCount: grouping.entityCount, keptSeparateCount: grouping.keptSeparateCount, entitiesPath: grouping.entitiesPath, addressFormsPath: grouping.addressFormsPath },
    status: 'structured',
  };
  if (input.stopAfter === 'group') return partial;

  // 4. Book-wide policies first.
  const policies = await smart.setPolicies({ runId: input.runId, firstChapterPath: input.chapterPaths[0] });
  // 5. One DebateWorkflow child per entity, all started at once; the smart queue paces the model calls.
  const entities = await local.listEntities(grouping.entitiesPath);
  const sources = entities.map((e) => e.source);
  const debates = await Promise.all(
    entities.map((e) =>
      executeChild(DebateWorkflow, {
        workflowId: `debate-${input.runId}-${e.source}`,
        taskQueue: TASK_QUEUES.workflows,
        args: [{ runId: input.runId, entitiesPath: grouping.entitiesPath, policiesPath: policies.policiesPath, source: e.source, type: e.type, otherSources: sources.filter((s) => s !== e.source) }],
      }),
    ),
  );
  // 6. Freeze: glossary.v1.json sorted by source, with code-side collision check.
  const entries = debates.map((d) => d.entry);
  const g = await local.writeGlossary({ runId: input.runId, entitiesPath: grouping.entitiesPath, entries });
  return {
    ...partial,
    policiesPath: policies.policiesPath,
    glossaryPath: g.glossaryPath,
    glossary: {
      entries: g.entryCount,
      byAgreement: entries.filter((e) => e.decided_by === 'agreement').length,
      debated: entries.filter((e) => e.decided_by === 'terminologist').length,
      needsHuman: entries.filter((e) => e.needs_human).length,
      modelCalls: 1 + debates.reduce((n, d) => n + d.calls, 0),
    },
    status: 'glossary-frozen',
  };
}

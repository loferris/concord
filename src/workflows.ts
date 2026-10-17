// Deterministic only: no I/O, no OpenAI import. Text never enters history; activities pass paths.
import { proxyActivities, executeChild } from '@temporalio/workflow';
import type * as activities from './activities';
import { TASK_QUEUES } from './config';
import type { GlossaryEntry, Proposal, Usage } from './schemas';
import type { Stance } from './prompts';
import { normRaw, normRendering } from './normalize';

const retry = { initialInterval: '2s', backoffCoefficient: 2, maximumInterval: '60s', maximumAttempts: 6 };

const fast = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.fast, startToCloseTimeout: '10 minutes', heartbeatTimeout: '15 seconds', retry });
// Decision calls get more attempts: 429s burn attempts too, and the family fallback starts at attempt 4.
const smart = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.smart, startToCloseTimeout: '10 minutes', heartbeatTimeout: '15 seconds', retry: { ...retry, maximumAttempts: 8 } });
// File-only activities: quick, no heartbeat needed.
const local = proxyActivities<typeof activities>({ taskQueue: TASK_QUEUES.smart, startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } });

// ---------------------------------------------------------------------------------------------
export interface ChapterWorkflowInput {
  runId: string;
  chapterPath: string;
  taggedPath?: string;
  glossaryPath?: string;
  policiesPath?: string;
  /** 0 = translate only (milestone 1 path); otherwise max review→revise rounds. */
  maxReviewRounds?: number;
}
export interface ChapterWorkflowResult {
  chapterName: string;
  paragraphCount: number;
  translationPath: string;
  englishPath: string;
  newTermCount: number;
  usage: Usage;
  rounds: { round: number; verdict: 'approve' | 'revise'; issues: { critical: number; major: number; minor: number }; lint: { banned: number; missing: number; cjk: number }; termDisputes: number }[];
  status: 'translated' | 'approved' | 'flagged';
}

const REVIEW_QUEUE_ROUNDS_DEFAULT = 3;

/** translate → term lint + review → revise (≤ maxReviewRounds) → approve or flag. */
export async function ChapterWorkflow(input: ChapterWorkflowInput): Promise<ChapterWorkflowResult> {
  const maxRounds = input.maxReviewRounds ?? REVIEW_QUEUE_ROUNDS_DEFAULT;
  let t = await fast.translateChapter({ runId: input.runId, chapterPath: input.chapterPath, taggedPath: input.taggedPath, glossaryPath: input.glossaryPath, policiesPath: input.policiesPath });
  const rounds: ChapterWorkflowResult['rounds'] = [];
  if (maxRounds === 0) return { ...t, rounds, status: 'translated' };
  let status: ChapterWorkflowResult['status'] = 'flagged';
  for (let round = 1; round <= maxRounds; round++) {
    const r = await smart.reviewChapter({ runId: input.runId, chapterPath: input.chapterPath, translationPath: t.translationPath, taggedPath: input.taggedPath, glossaryPath: input.glossaryPath, round });
    rounds.push({ round, verdict: r.verdict, issues: r.issues, lint: r.lint, termDisputes: r.termDisputes });
    const lintTotal = r.lint.banned + r.lint.missing + r.lint.cjk;
    if (r.verdict === 'approve' && lintTotal === 0) {
      status = 'approved';
      break;
    }
    if (round === maxRounds) break; // out of rounds: flagged
    t = await fast.translateChapter({ runId: input.runId, chapterPath: input.chapterPath, taggedPath: input.taggedPath, glossaryPath: input.glossaryPath, policiesPath: input.policiesPath, revision: { round, issues: r.revisionIssues } });
  }
  return { ...t, rounds, status };
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
  /** Incremental mode: frozen glossary as precedent for proposers, critic and terminologist. */
  precedentGlossaryPath?: string;
}
export interface DebateWorkflowResult {
  entry: GlossaryEntry;
  calls: number;
  /** How the three proposals compared: identical after case/whitespace, identical only after article/quote/hyphen normalization, or different. */
  agreement: 'raw' | 'normalized' | 'none';
  rawRenderings: string[];
}

const STANCES: Stance[] = ['fidelity', 'readability', 'genre'];

/** One contested-or-not term: three blind proposers; agreement freezes, otherwise critic → terminologist. */
export async function DebateWorkflow(input: DebateWorkflowInput): Promise<DebateWorkflowResult> {
  const base = { runId: input.runId, entitiesPath: input.entitiesPath, policiesPath: input.policiesPath, source: input.source, precedentGlossaryPath: input.precedentGlossaryPath };
  // A single looping proposer must not fail the debate: proceed with the proposals that arrived.
  const settled = await Promise.allSettled(STANCES.map((stance) => smart.propose({ ...base, stance })));
  const proposals = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failedStances = STANCES.filter((_, i) => settled[i].status === 'rejected');
  if (!proposals.length) throw new Error(`all three proposers failed for ${input.source}`);
  const ps: Proposal[] = proposals.map((p) => p.proposal);
  const failureNotes = failedStances.map((st) => `proposer ${st} failed after retries (model loop or rate limit); decided from ${ps.length} proposal(s)`);
  const rawKeys = ps.map((p) => normRaw(p.rendering));
  const normKeys = ps.map((p) => normRendering(p.rendering));
  // Agreement needs at least two proposals; a lone proposal goes to the terminologist.
  const agreement: DebateWorkflowResult['agreement'] = ps.length < 2 ? 'none' : rawKeys.every((r) => r === rawKeys[0]) ? 'raw' : normKeys.every((r) => r === normKeys[0]) ? 'normalized' : 'none';
  const rawRenderings = ps.map((p) => p.rendering);
  const aliasesFromEntity = await local.listEntityAliases({ entitiesPath: input.entitiesPath, source: input.source });

  if (agreement !== 'none') {
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
      code_notes: [...failureNotes, ...(agreement === 'normalized' ? [`agreement after normalization of: ${rawRenderings.join(' | ')}`] : [])],
    };
    return { entry, calls: ps.length, agreement, rawRenderings };
  }

  // The critic compares three proposals; with fewer, go straight to the terminologist.
  const critique = ps.length === 3 ? (await smart.critique({ ...base, proposals: ps, otherSources: input.otherSources })).critique : null;
  const { decision, notes } = await smart.decide({ ...base, proposals: ps, critique, otherSources: input.otherSources });
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
    code_notes: [...failureNotes, ...notes],
  };
  return { entry, calls: ps.length + (critique ? 2 : 1), agreement, rawRenderings };
}

// ---------------------------------------------------------------------------------------------
export interface BookWorkflowInput {
  runId: string;
  chapterPaths: string[];
  /** Stop early for inspection: 'group' = after tag/extract/group (2a); 'glossary' = after glossary.v2 (2b). */
  stopAfter?: 'group' | 'glossary';
}

export interface TranslationPhaseResult {
  glossaryUsed: string;
  chapters: { chapterName: string; paragraphCount: number; newTermCount: number; translationPath: string; englishPath: string; status: ChapterWorkflowResult['status']; rounds: ChapterWorkflowResult['rounds'] }[];
  baseline: { chapterName: string; englishPath: string }[];
  checks: { full: import('./checks').CheckSummary; baseline: import('./checks').CheckSummary; fullPath: string; baselinePath: string };
}

/**
 * Milestone 3: translate the first chapter alone (warms the shared prefix cache), then the rest in parallel;
 * run the one-prompt baseline on every chapter; run the code checks on both.
 */
async function translationPhase(runId: string, chapterPaths: string[], taggedPaths: string[], glossaryPath: string, policiesPath: string, maxReviewRounds = REVIEW_QUEUE_ROUNDS_DEFAULT): Promise<TranslationPhaseResult> {
  const [first, ...rest] = chapterPaths;
  const tr = (i: number) =>
    executeChild(ChapterWorkflow, {
      workflowId: `chapter-${runId}-${chapterPaths[i].split('/').pop()!.replace(/\.[^.]+$/, '')}`,
      taskQueue: TASK_QUEUES.workflows,
      args: [{ runId, chapterPath: chapterPaths[i], taggedPath: taggedPaths[i], glossaryPath, policiesPath, maxReviewRounds }],
    });
  const firstOut = await tr(0);
  const [restOut, baseline] = await Promise.all([
    Promise.all(rest.map((_, i) => tr(i + 1))),
    Promise.all(chapterPaths.map((chapterPath) => fast.translateBaseline({ runId, chapterPath }))),
  ]);
  const chapters = [firstOut, ...restOut];
  const names = chapters.map((c) => c.chapterName);
  const [full, base] = await Promise.all([
    local.runChecks({ runId, glossaryPath, label: 'full', chapters: chapters.map((c, i) => ({ name: c.chapterName, sourcePath: chapterPaths[i], englishPath: c.englishPath, translationPath: c.translationPath })) }),
    local.runChecks({ runId, glossaryPath, label: 'baseline', chapters: baseline.map((b, i) => ({ name: b.chapterName, sourcePath: chapterPaths[names.indexOf(b.chapterName)] ?? chapterPaths[i], englishPath: b.englishPath })) }),
  ]);
  return {
    glossaryUsed: glossaryPath,
    chapters: chapters.map((c) => ({ chapterName: c.chapterName, paragraphCount: c.paragraphCount, newTermCount: c.newTermCount, translationPath: c.translationPath, englishPath: c.englishPath, status: c.status, rounds: c.rounds })),
    baseline: baseline.map((b) => ({ chapterName: b.chapterName, englishPath: b.englishPath })),
    checks: { full: full.summary, baseline: base.summary, fullPath: full.checksPath, baselinePath: base.checksPath },
  };
}

export interface TranslateBookWorkflowInput {
  runId: string;
  /** A finished BookWorkflow run whose tagged chapters, policies and glossary.v2 are reused. */
  glossaryRunId: string;
  chapterPaths: string[];
  glossaryVersion?: number;
  maxReviewRounds?: number;
}
/** Reuse an existing glossary run: translation + baseline + checks only. */
export async function TranslateBookWorkflow(input: TranslateBookWorkflowInput): Promise<TranslationPhaseResult & { runId: string; glossaryRunId: string }> {
  const base = `run-data/${input.glossaryRunId}`;
  const names = input.chapterPaths.map((p) => p.split('/').pop()!.replace(/\.[^.]+$/, ''));
  const taggedPaths = names.map((n) => `${base}/chapters/${n}/tagged.json`);
  const res = await translationPhase(input.runId, input.chapterPaths, taggedPaths, `${base}/glossary/glossary.v${input.glossaryVersion ?? 2}.json`, `${base}/glossary/policies.json`, input.maxReviewRounds);
  return { ...res, runId: input.runId, glossaryRunId: input.glossaryRunId };
}
export interface BookWorkflowResult {
  runId: string;
  tagged: { chapterName: string; paragraphCount: number; segmentCount: number }[];
  extraction: { candidateCount: number; itemCount: number; rejectedCount: number; captureRecapture: { runA: number; runB: number; both: number; union: number; estimatedTotal: number; estimatedRecall: number } };
  grouping: { entityCount: number; keptSeparateCount: number; entitiesPath: string; addressFormsPath: string };
  policiesPath?: string;
  glossaryPath?: string;
  /** glossary.v2.json after the nested-term pass (same as v1 when nothing violated). */
  glossaryV2Path?: string;
  nestedViolationsFixed?: string[];
  translation?: TranslationPhaseResult;
  glossary?: { entries: number; byAgreement: number; agreementRaw: number; agreementNormalized: number; debated: number; needsHuman: number; modelCalls: number };
  status: 'structured' | 'glossary-frozen' | 'translated';
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
    extraction: { candidateCount: extraction.candidateCount, itemCount: extraction.itemCount, rejectedCount: extraction.rejectedCount, captureRecapture: { runA: extraction.captureRecapture.runA, runB: extraction.captureRecapture.runB, both: extraction.captureRecapture.both, union: extraction.captureRecapture.union, estimatedTotal: extraction.captureRecapture.estimatedTotal, estimatedRecall: extraction.captureRecapture.estimatedRecall } },
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
  const g = await local.writeGlossary({ runId: input.runId, entitiesPath: grouping.entitiesPath, entries, version: 1 });

  // 7. Nested-term rule: if A's source contains B's source, A's rendering must contain B's. Re-decide only
  //    the violators with B's rendering as a frozen constraint, sequentially, and write glossary.v2.json.
  const violations = await local.findNestedViolations(g.glossaryPath);
  const v2 = [...entries];
  const fixed: string[] = [];
  const bySource = new Set(violations.map((v) => v.source));
  for (const source of bySource) {
    const cs = violations.filter((v) => v.source === source).map((v) => ({ within: v.within, requiredRendering: v.requiredRendering }));
    const i = v2.findIndex((e) => e.source === source);
    const prev = v2[i];
    const { decision, notes } = await smart.decide({
      runId: input.runId,
      entitiesPath: grouping.entitiesPath,
      policiesPath: policies.policiesPath,
      source,
      proposals: [{ rendering: prev.rendering, alias_renderings: prev.alias_renderings, banned: prev.banned, confidence: prev.confidence, rationale: prev.rationale }],
      critique: null,
      otherSources: sources.filter((s) => s !== source),
      constraints: cs,
    });
    v2[i] = {
      ...prev,
      rendering: decision.rendering.trim(),
      alias_renderings: decision.alias_renderings,
      banned: decision.banned,
      context_rules: decision.context_rules,
      decided_by: 'terminologist',
      rationale: decision.rationale,
      confidence: decision.confidence,
      needs_human: decision.needs_human,
      needs_human_reason: decision.needs_human ? decision.rationale : null,
      code_notes: [...prev.code_notes, `v2: re-decided under nested-term constraint (${cs.map((c) => `${c.within} → ${c.requiredRendering}`).join('; ')}); was "${prev.rendering}"`, ...notes],
    };
    fixed.push(`${source}: "${prev.rendering}" → "${decision.rendering}"`);
  }
  const g2 = await local.writeGlossary({ runId: input.runId, entitiesPath: grouping.entitiesPath, entries: v2, version: 2 });
  const frozen: BookWorkflowResult = {
    ...partial,
    policiesPath: policies.policiesPath,
    glossaryPath: g.glossaryPath,
    glossaryV2Path: g2.glossaryPath,
    nestedViolationsFixed: fixed,
    glossary: {
      entries: g.entryCount,
      byAgreement: entries.filter((e) => e.decided_by === 'agreement').length,
      agreementRaw: debates.filter((d) => d.agreement === 'raw').length,
      agreementNormalized: debates.filter((d) => d.agreement === 'normalized').length,
      debated: entries.filter((e) => e.decided_by === 'terminologist').length,
      needsHuman: entries.filter((e) => e.needs_human).length,
      modelCalls: 1 + debates.reduce((n, d) => n + d.calls, 0) + fixed.length,
    },
    status: 'glossary-frozen',
  };
  if (input.stopAfter === 'glossary') return frozen;

  // 8. Translate against glossary.v2: first chapter alone, then the rest in parallel; baseline; checks.
  const translation = await translationPhase(input.runId, input.chapterPaths, tagged.map((t) => t.taggedPath), g2.glossaryPath, policies.policiesPath);
  return { ...frozen, translation, status: 'translated' };
}

// ---------------------------------------------------------------------------------------------
// Incremental mode: chapters arrive one at a time; the glossary grows by one version per chapter.
export interface AddChapterWorkflowInput {
  runId: string;
  chapterPath: string;
  /** 0 when no glossary exists yet. */
  previousVersion: number;
  maxReviewRounds?: number;
}
export interface AddChapterWorkflowResult {
  runId: string;
  chapterName: string;
  version: number;
  glossaryPath: string;
  changelog: import('./activities').ChangelogEntry;
  chapter: ChapterWorkflowResult;
}

export async function AddChapterWorkflow(input: AddChapterWorkflowInput): Promise<AddChapterWorkflowResult> {
  const stepStartedAt = new Date().toISOString(); // deterministic in Temporal workflows
  const chapterName = input.chapterPath.split('/').pop()!.replace(/\.[^.]+$/, '');
  const base = `run-data/${input.runId}`;
  const prevGlossary = input.previousVersion > 0 ? `${base}/glossary/glossary.v${input.previousVersion}.json` : null;
  const prevEntities = input.previousVersion > 0 ? `${base}/glossary/incremental/entities.latest.json` : null;
  const version = input.previousVersion + 1;

  // 1. Tag, extract (this chapter alone), diff + group against the existing entities.
  const tagged = await smart.tagChapter({ runId: input.runId, chapterPath: input.chapterPath });
  const knownSources = prevGlossary ? await local.listGlossarySources(prevGlossary) : [];
  const extraction = await fast.extractTerms({ runId: input.runId, chapterPaths: [input.chapterPath], incremental: { knownSources, chapterName } });
  let grouping: { entitiesPath: string; newEntities: string[]; newAliases: { alias: string; entity: string; used_by: string }[] };
  if (input.previousVersion === 0) {
    // First chapter: nothing is known yet, so group within the chapter with the batch grouper.
    const g0 = await smart.groupAliases({ runId: input.runId, extractionPath: extraction.extractionPath, taggedPaths: [tagged.taggedPath], addressFormsPaths: [tagged.addressFormsPath] });
    const ents = await local.listEntities(g0.entitiesPath);
    grouping = { entitiesPath: g0.entitiesPath, newEntities: ents.map((e) => e.source), newAliases: [] };
  } else {
    grouping = await smart.groupIncremental({ runId: input.runId, chapterName, extractionPath: extraction.extractionPath, taggedPath: tagged.taggedPath, addressFormsPath: tagged.addressFormsPath, glossaryPath: prevGlossary, entitiesPath: prevEntities });
  }
  await local.copyFile({ from: grouping.entitiesPath, to: `${base}/glossary/incremental/entities.latest.json` });

  // 2. Policies once, before any term.
  const policiesPath = `${base}/glossary/policies.json`;
  if (input.previousVersion === 0) await smart.setPolicies({ runId: input.runId, firstChapterPath: input.chapterPath });

  // 3. Debate only the new entities, with the frozen glossary as precedent. New aliases of existing entities
  //    get a rendering from one terminologist call (the entity's rendering is frozen; only the alias is new).
  const allSources = [...knownSources, ...grouping.newEntities];
  const debates = await Promise.all(
    grouping.newEntities.map((source) =>
      executeChild(DebateWorkflow, {
        workflowId: `debate-${input.runId}-v${version}-${source}`,
        taskQueue: TASK_QUEUES.workflows,
        args: [{ runId: input.runId, entitiesPath: grouping.entitiesPath, policiesPath, source, type: 'term', otherSources: allSources.filter((s) => s !== source), precedentGlossaryPath: prevGlossary ?? undefined }],
      }),
    ),
  );
  const aliasRenderings: { entity: string; source: string; rendering: string }[] = [];
  for (const a of grouping.newAliases) {
    const { decision } = await smart.decide({ runId: input.runId, entitiesPath: grouping.entitiesPath, policiesPath, source: a.entity, proposals: [], critique: null, otherSources: allSources.filter((s) => s !== a.entity), precedentGlossaryPath: prevGlossary ?? undefined, frozenRendering: true });
    const r = decision.alias_renderings.find((x) => x.source === a.alias);
    aliasRenderings.push({ entity: a.entity, source: a.alias, rendering: r?.rendering ?? decision.rendering });
  }
  // Entity types come from the grouping record, not the debate input default.
  const types = await local.listEntities(grouping.entitiesPath);
  const newEntries = debates.map((d) => ({ ...d.entry, type: types.find((t) => t.source === d.entry.source)?.type ?? d.entry.type }));

  // 4. Write glossary.v{N+1} + changelog (frozen entries unchanged).
  const g = await local.writeGlossaryVersion({ runId: input.runId, chapterName, previousGlossaryPath: prevGlossary, version, newEntries, newAliases: grouping.newAliases, aliasRenderings, debates: debates.filter((d) => d.agreement === 'none').length, stepStartedAt });

  // 5. Translate + review this chapter against the new version (+ baseline for the eval).
  const [chapter] = await Promise.all([
    executeChild(ChapterWorkflow, { workflowId: `chapter-${input.runId}-${chapterName}`, taskQueue: TASK_QUEUES.workflows, args: [{ runId: input.runId, chapterPath: input.chapterPath, taggedPath: tagged.taggedPath, glossaryPath: g.glossaryPath, policiesPath, maxReviewRounds: input.maxReviewRounds }] }),
    fast.translateBaseline({ runId: input.runId, chapterPath: input.chapterPath }),
  ]);
  return { runId: input.runId, chapterName, version, glossaryPath: g.glossaryPath, changelog: g.changelog, chapter };
}

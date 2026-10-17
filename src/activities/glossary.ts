import { ApplicationFailure } from '@temporalio/common';
import { MODELS } from '../config';
import { dedupeBanned, hasCJK, normRaw } from '../normalize';
import { chatJson } from '../llm';
import { criticPrompt, formatCritique, formatEntity, formatPolicies, formatProposal, policiesPrompt, proposerPrompt, terminologistPrompt, type Stance } from '../prompts';
import { CritiqueSchema, PoliciesSchema, ProposalSchema, TerminologistSchema, type Critique, type Glossary, type GlossaryEntry, type Policies, type Proposal, type TerminologistDecision, type Usage } from '../schemas';
import { splitParagraphs } from '../text';
import { readText, recordUsage, runDir, writeJsonAtomic } from './io';
import { attemptSeed, modelForAttempt, withHeartbeat } from './common';
import type { EntityRecord } from './group';

// ---- 3. Policies ----
export interface SetPoliciesInput {
  runId: string;
  firstChapterPath: string;
}
export interface SetPoliciesOutput {
  policiesPath: string;
  policyCount: number;
  usage: Usage;
}
export async function setPolicies(input: SetPoliciesInput): Promise<SetPoliciesOutput> {
  return withHeartbeat(async () => {
    const paras = splitParagraphs(await readText(input.firstChapterPath)).slice(0, 14);
    const prompt = policiesPrompt(paras.map((p) => `[${p.id}]\n${p.text}`).join('\n\n'));
    const res = await chatJson({ model: decisionModel(), ...prompt, schemaName: 'policies', maxTokens: 4096, seed: attemptSeed(), enableThinking: false }, PoliciesSchema);
    // The prompt asks for six decisions. Zero is a failed call; fewer than six is worth a warning.
    const policies = res.data.policies.filter((p) => p.topic.trim() && p.rule.trim());
    if (!policies.length) throw ApplicationFailure.create({ type: 'PoliciesEmpty', message: 'policy setter returned no usable policies', nonRetryable: false });
    if (policies.length < 6) console.log(`[policies] only ${policies.length}/6 policies returned`);
    const policiesPath = runDir(input.runId, 'glossary', 'policies.json');
    await writeJsonAtomic(policiesPath, { policies });
    await recordUsage(input.runId, 'policies', 'book', res.usage);
    return { policiesPath, policyCount: policies.length, usage: res.usage };
  });
}

/** Super decides; Lightning (same family) takes over from the third attempt if Super loops. */
const decisionModel = () => modelForAttempt(MODELS.smart, MODELS.extractor, 4);

/** A rendering must be non-empty English; a stray Chinese character means the model echoed the source. */
function checkRendering(role: string, rendering: string, source: string): void {
  if (!rendering.trim() || hasCJK(rendering)) {
    throw ApplicationFailure.create({ type: 'BadRendering', message: `${role} for ${source}: rendering "${rendering}" is empty or contains CJK`, nonRetryable: false });
  }
}

async function loadEntity(entitiesPath: string, source: string): Promise<EntityRecord> {
  const { entities } = JSON.parse(await readText(entitiesPath)) as { entities: EntityRecord[] };
  const e = entities.find((x) => x.canonical_source === source);
  if (!e) throw new Error(`entity not found: ${source}`);
  return e;
}
async function loadPolicies(policiesPath: string): Promise<string> {
  return formatPolicies(JSON.parse(await readText(policiesPath)) as Policies);
}
function entityAndContexts(e: EntityRecord): string {
  return `${formatEntity(e)}\ncontexts:\n${e.contexts.join('\n')}`;
}

// ---- 4. Proposer ----
export interface ProposeInput {
  runId: string;
  entitiesPath: string;
  policiesPath: string;
  source: string;
  stance: Stance;
}
export interface ProposeOutput {
  stance: Stance;
  proposal: Proposal;
  usage: Usage;
}
export async function propose(input: ProposeInput): Promise<ProposeOutput> {
  return withHeartbeat(async () => {
    const e = await loadEntity(input.entitiesPath, input.source);
    const prompt = proposerPrompt(input.stance, await loadPolicies(input.policiesPath), formatEntity(e), e.contexts.join('\n'));
    // Each stance samples independently (own seed offset); with one shared seed at low temperature the three
    // "blind translators" converged on the same output and nothing was ever debated.
    const stanceOffset = { fidelity: 0, readability: 1000, genre: 2000 }[input.stance];
    const res = await chatJson({ model: decisionModel(), ...prompt, schemaName: 'proposal', maxTokens: 2048, seed: attemptSeed() + stanceOffset, enableThinking: false }, ProposalSchema);
    checkRendering(`proposer(${input.stance})`, res.data.rendering, input.source);
    for (const a of res.data.alias_renderings) checkRendering(`proposer(${input.stance}) alias ${a.source}`, a.rendering, input.source);
    // Banned variants never include the proposed rendering itself; dedupe case-insensitively.
    const proposal: Proposal = { ...res.data, rendering: res.data.rendering.trim(), banned: dedupeBanned(res.data.banned, [res.data.rendering]) };
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, `proposal.${input.stance}.json`), { ...proposal, usage: res.usage });
    await recordUsage(input.runId, `proposer.${input.stance}`, input.source, res.usage);
    return { stance: input.stance, proposal, usage: res.usage };
  });
}

// ---- 5. Critic ----
export interface CritiqueInput {
  runId: string;
  entitiesPath: string;
  policiesPath: string;
  source: string;
  proposals: Proposal[];
  otherSources: string[];
}
export async function critique(input: CritiqueInput): Promise<{ critique: Critique; usage: Usage }> {
  return withHeartbeat(async () => {
    const e = await loadEntity(input.entitiesPath, input.source);
    const [a, b, c] = input.proposals.map(formatProposal);
    const prompt = criticPrompt(await loadPolicies(input.policiesPath), entityAndContexts(e), a, b, c, input.otherSources.join(', ') || '(none yet)');
    const res = await chatJson({ model: decisionModel(), ...prompt, schemaName: 'critique', maxTokens: 2048, seed: attemptSeed(), enableThinking: false }, CritiqueSchema);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, 'critique.json'), { ...res.data, usage: res.usage });
    await recordUsage(input.runId, 'critic', input.source, res.usage);
    return { critique: res.data, usage: res.usage };
  });
}

// ---- 6. Terminologist ----
export interface DecideInput {
  runId: string;
  entitiesPath: string;
  policiesPath: string;
  source: string;
  proposals: Proposal[];
  critique: Critique | null;
  otherSources: string[];
}
export async function decide(input: DecideInput): Promise<{ decision: TerminologistDecision; usage: Usage; notes: string[] }> {
  return withHeartbeat(async () => {
    const e = await loadEntity(input.entitiesPath, input.source);
    const proposals = input.proposals.map((p, i) => `${'ABC'[i]}: ${formatProposal(p)}`).join('\n');
    const prompt = terminologistPrompt(await loadPolicies(input.policiesPath), input.otherSources.join(', ') || '(none yet)', entityAndContexts(e), proposals, input.critique ? formatCritique(input.critique) : 'none');
    const res = await chatJson({ model: decisionModel(), ...prompt, schemaName: 'terminologist', maxTokens: 2048, seed: attemptSeed(), enableThinking: false }, TerminologistSchema);
    checkRendering('terminologist', res.data.rendering, input.source);
    for (const a of res.data.alias_renderings) checkRendering(`terminologist alias ${a.source}`, a.rendering, input.source);
    const notes: string[] = [];
    const decision: TerminologistDecision = { ...res.data, rendering: res.data.rendering.trim() };
    if (decision.source.trim() !== input.source) {
      notes.push(`terminologist wrote source "${decision.source}"; corrected to "${input.source}"`);
      decision.source = input.source;
    }
    const banned = dedupeBanned(decision.banned, [decision.rendering, ...decision.alias_renderings.map((a) => a.rendering)]);
    if (banned.length !== decision.banned.length) notes.push('removed banned variants equal to the chosen rendering(s) or duplicates');
    decision.banned = banned;
    // Every alias needs a rendering; fill gaps from the proposals (first proposal that rendered it).
    for (const a of e.aliases) {
      if (!decision.alias_renderings.some((x) => x.source === a.source)) {
        const hit = input.proposals.map((p) => p.alias_renderings.find((x) => x.source === a.source)).find(Boolean);
        decision.alias_renderings.push({ source: a.source, rendering: hit?.rendering ?? decision.rendering });
        notes.push(`alias ${a.source} had no rendering; filled from ${hit ? 'a proposal' : 'the main rendering'}`);
      }
    }
    const rules = decision.context_rules.filter((r) => r.when.trim() && r.rendering.trim());
    if (rules.length !== decision.context_rules.length) notes.push('dropped context rules with empty condition or rendering');
    decision.context_rules = rules;
    if (notes.length) console.log(`[decide] ${input.source}: ${notes.join('; ')}`);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, 'decision.json'), { ...decision, code_notes: notes, usage: res.usage });
    await recordUsage(input.runId, 'terminologist', input.source, res.usage);
    return { decision, usage: res.usage, notes };
  });
}

// ---- Glossary writer (code only) ----
export interface WriteGlossaryInput {
  runId: string;
  entitiesPath: string;
  entries: GlossaryEntry[];
}
export async function writeGlossary(input: WriteGlossaryInput): Promise<{ glossaryPath: string; entryCount: number }> {
  const entries = [...input.entries].map((e) => ({ ...e, code_notes: [...e.code_notes] })).sort((a, b) => a.source.localeCompare(b.source, 'zh'));
  const flag = (e: GlossaryEntry, why: string) => {
    e.needs_human = true;
    e.needs_human_reason = [e.needs_human_reason, why].filter(Boolean).join('; ');
  };
  // Final guards (the activities already retry on these, so hitting them here is rare):
  // 1. a rendering that still contains CJK cannot be frozen; 2. two sources must not share a rendering;
  // 3. a banned variant that is another entry's rendering would make the lint flag correct text.
  const allRenderings = new Map<string, string>(); // normRaw(rendering) -> source
  for (const e of entries) for (const r of [e.rendering, ...e.alias_renderings.map((a) => a.rendering)]) if (!allRenderings.has(normRaw(r))) allRenderings.set(normRaw(r), e.source);
  const byRendering = new Map<string, string[]>();
  for (const e of entries) byRendering.set(normRaw(e.rendering), [...(byRendering.get(normRaw(e.rendering)) ?? []), e.source]);
  for (const e of entries) {
    if (hasCJK(e.rendering) || e.alias_renderings.some((a) => hasCJK(a.rendering))) flag(e, 'rendering contains CJK');
    const others = (byRendering.get(normRaw(e.rendering)) ?? []).filter((s) => s !== e.source);
    if (others.length) flag(e, `rendering collides with ${others.join(', ')}`);
    const kept = e.banned.filter((b) => {
      const owner = allRenderings.get(normRaw(b));
      if (owner && owner !== e.source) {
        e.code_notes.push(`banned "${b}" removed: it is the rendering of ${owner}`);
        return false;
      }
      return true;
    });
    e.banned = dedupeBanned(kept, [e.rendering, ...e.alias_renderings.map((a) => a.rendering)]);
  }
  const glossary: Glossary = { version: 1, runId: input.runId, entries };
  const glossaryPath = runDir(input.runId, 'glossary', 'glossary.v1.json');
  await writeJsonAtomic(glossaryPath, glossary);
  return { glossaryPath, entryCount: entries.length };
}

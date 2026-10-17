import { MODELS, EVAL_SEED } from '../config';
import { chatJson } from '../llm';
import { criticPrompt, formatCritique, formatEntity, formatPolicies, formatProposal, policiesPrompt, proposerPrompt, terminologistPrompt, type Stance } from '../prompts';
import { CritiqueSchema, PoliciesSchema, ProposalSchema, TerminologistSchema, type Critique, type Glossary, type GlossaryEntry, type Policies, type Proposal, type TerminologistDecision, type Usage } from '../schemas';
import { splitParagraphs } from '../text';
import { readText, runDir, writeJsonAtomic } from './io';
import { withHeartbeat } from './common';
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
    const res = await chatJson({ model: MODELS.smart, ...prompt, schemaName: 'policies', maxTokens: 4096, seed: EVAL_SEED, enableThinking: false }, PoliciesSchema);
    const policiesPath = runDir(input.runId, 'glossary', 'policies.json');
    await writeJsonAtomic(policiesPath, res.data);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'policies.usage.json'), res.usage);
    return { policiesPath, policyCount: res.data.policies.length, usage: res.usage };
  });
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
    const res = await chatJson({ model: MODELS.smart, ...prompt, schemaName: 'proposal', maxTokens: 2048, seed: EVAL_SEED, enableThinking: false }, ProposalSchema);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, `proposal.${input.stance}.json`), { ...res.data, usage: res.usage });
    return { stance: input.stance, proposal: res.data, usage: res.usage };
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
    const res = await chatJson({ model: MODELS.smart, ...prompt, schemaName: 'critique', maxTokens: 2048, seed: EVAL_SEED, enableThinking: false }, CritiqueSchema);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, 'critique.json'), { ...res.data, usage: res.usage });
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
export async function decide(input: DecideInput): Promise<{ decision: TerminologistDecision; usage: Usage }> {
  return withHeartbeat(async () => {
    const e = await loadEntity(input.entitiesPath, input.source);
    const proposals = input.proposals.map((p, i) => `${'ABC'[i]}: ${formatProposal(p)}`).join('\n');
    const prompt = terminologistPrompt(await loadPolicies(input.policiesPath), input.otherSources.join(', ') || '(none yet)', entityAndContexts(e), proposals, input.critique ? formatCritique(input.critique) : 'none');
    const res = await chatJson({ model: MODELS.smart, ...prompt, schemaName: 'terminologist', maxTokens: 2048, seed: EVAL_SEED, enableThinking: false }, TerminologistSchema);
    await writeJsonAtomic(runDir(input.runId, 'glossary', 'debates', input.source, 'decision.json'), { ...res.data, usage: res.usage });
    return { decision: res.data, usage: res.usage };
  });
}

// ---- Glossary writer (code only) ----
export interface WriteGlossaryInput {
  runId: string;
  entitiesPath: string;
  entries: GlossaryEntry[];
}
export async function writeGlossary(input: WriteGlossaryInput): Promise<{ glossaryPath: string; entryCount: number }> {
  const entries = [...input.entries].sort((a, b) => a.source.localeCompare(b.source, 'zh'));
  // Collision check: two different sources must not share a rendering.
  const byRendering = new Map<string, string[]>();
  for (const e of entries) {
    const k = e.rendering.trim().toLowerCase();
    byRendering.set(k, [...(byRendering.get(k) ?? []), e.source]);
  }
  for (const e of entries) {
    const others = (byRendering.get(e.rendering.trim().toLowerCase()) ?? []).filter((s) => s !== e.source);
    if (others.length) {
      e.needs_human = true;
      e.needs_human_reason = [e.needs_human_reason, `rendering collides with ${others.join(', ')}`].filter(Boolean).join('; ');
    }
  }
  const glossary: Glossary = { version: 1, runId: input.runId, entries };
  const glossaryPath = runDir(input.runId, 'glossary', 'glossary.v1.json');
  await writeJsonAtomic(glossaryPath, glossary);
  return { glossaryPath, entryCount: entries.length };
}

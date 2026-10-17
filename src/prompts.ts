// Prompt templates, verbatim from docs/prompts.md. Each returns { system, user } with the stable part
// first (system) and the per-call material last (user) for prefix caching.
import type { TaggedChapter, Policies, Entity, Proposal, Critique } from './schemas';

export interface Prompt {
  system: string;
  user: string;
}

export const STANCES = {
  fidelity:
    "Your priority is accuracy to the source meaning, including connotation and wordplay. You'd rather an English reader learn a term than lose what it means.",
  readability:
    'Your priority is how the rendering reads to an English-speaking reader of contemporary fiction. It must be natural in dialogue and survive repeating fifty times.',
  genre:
    'Your priority is how published and fan translations of Chinese web fiction conventionally render terms like this, so readers of the genre recognize it.',
} as const;
export type Stance = keyof typeof STANCES;

// ---- 0. Tagger ----
export function taggerPrompt(paragraphsBlock: string): Prompt {
  return {
    system: `You annotate the structure of a Chinese novel chapter. You are NOT a translator.

DO NOT TRANSLATE. Every "text" field you return must be the original Chinese, copied
character for character from the source: same characters, same full-width punctuation,
same quotation marks (“ ” not " "), same spacing. Do not summarize, correct, simplify,
or convert anything. Only the labels (type, speaker, addressee, address_form) are yours,
and those are also written in Chinese exactly as the text names the person.

Split each paragraph into consecutive segments and label each one:
- narration
- speech: spoken dialogue. Give the speaker and, when clear, the addressee.
- thought: unspoken inner thought. Give whose thought it is.
- text_message: written messages, notes, screen text, logs. Give the sender if known.

Identify speakers by the name the narration uses for them (沈澈, 陆楠, 周总...). If the speaker
is unclear, use "unknown"; never guess. Also record the form of address used in a speech
segment when one appears (沈哥, 阿澈, 小鹿, 师父, 师傅), with who is addressing whom.

Concatenating each paragraph's segments in order must reproduce the paragraph exactly,
including punctuation and quotation marks. Your output is checked by code; any translated,
altered, or missing character makes it fail.`,
    user: `CHAPTER (paragraph IDs in brackets):
${paragraphsBlock}

Reminder: return the Chinese text unchanged. Do not translate.`,
  };
}

// ---- 1. Extractor ----
export function extractorPrompt(candidatesBlock: string, bookBlock: string): Prompt {
  return {
    system: `You are a terminology extractor for a Chinese→English literary translation team.

Read the Chinese text and list every item whose English rendering must stay the same
everywhere in the book. Include:
- people's names, and every other way a person is referred to: nicknames (小鹿),
  relationship or workplace forms of address (沈哥, 阿澈), and titles (周总)
- organizations, products, systems, places, invented terms (夜航, 复核组, 人工先验)
- domain terms used as fixed jargon (白名单, 灰名单)
- recurring phrases or refrains that repeat verbatim
- characters or words that look or sound alike but mean different things in context
  (for example 师父 "mentor" vs. 师傅 "driver/tradesperson"). List them as SEPARATE items.

Do NOT include ordinary vocabulary that any translator would render consistently anyway.

For each item give the exact source string as it appears, its type, the paragraph IDs where
it appears, and whether it needs a fixed rendering and why. If an item is a form of address
for a person, say which person. If unsure whether something is a term, include it with
needs_fixed_rendering=false and explain.`,
    user: `Candidate strings found by frequency analysis (may contain noise; confirm or reject each):
${candidatesBlock}

TEXT (paragraph IDs in brackets):
${bookBlock}`,
  };
}

// ---- 2. Alias grouper ----
export function grouperPrompt(itemsBlock: string, addressFormTable: string): Prompt {
  return {
    system: `You group terms that refer to the same entity, so each entity gets one glossary entry
with its aliases.

Rules:
- Group a full name with its nicknames, forms of address and titles ONLY when the contexts
  show they are the same person or thing. Speaker tags are strong evidence: if 陆楠 says
  "沈哥" and the narration says she is talking to 沈澈, then 沈哥 is how 陆楠 addresses 沈澈.
- Never group items just because they share characters or sound alike. 师父 and 师傅 are
  different words even though they sound the same.
- A wrong merge is worse than a missed one. If unsure, keep items separate and say why.`,
    user: `ITEMS WITH CONTEXTS (contexts are tagged with speaker/addressee where relevant):
${itemsBlock}

ADDRESS FORMS OBSERVED BY THE TAGGER (who → whom: form):
${addressFormTable}`,
  };
}

// ---- 3. Policy setter ----
export function policiesPrompt(openingParagraphs: string): Prompt {
  return {
    system: `Before any individual terms are decided, set the book-wide translation policies for this
Chinese→English novel. Decide each one, give a one-line rule and an example from the text:
1. Personal names: pinyin, surname first, no tone marks?
2. Forms of address (沈哥, 阿澈) and nicknames (小鹿): translate, romanize, or adapt?
   Consider that English readers will see them repeatedly.
3. Titles (周总, 师父): translate, romanize, or both on first use?
4. Invented system and product names: translate meaning, romanize, or keep both?
5. Spelling convention (US or UK) and hyphenation of compound terms.
6. Register and tense of narration and dialogue.

Prefer what an experienced published translator of contemporary Chinese fiction would do.
Keep it short; these rules will be applied to every later decision.`,
    user: `TEXT SAMPLE:
${openingParagraphs}`,
  };
}

export function formatPolicies(p: Policies): string {
  return p.policies.map((x, i) => `${i + 1}. ${x.topic}: ${x.rule} (e.g. ${x.example_source} → ${x.example_target})`).join('\n');
}

export function formatEntity(e: Entity): string {
  const aliases = e.aliases.length
    ? e.aliases.map((a) => `${a.source} [${a.kind}${a.used_by ? `, used by ${a.used_by}` : ''}]`).join('; ')
    : '(none)';
  return `source: ${e.canonical_source}\ntype: ${e.type}\naliases: ${aliases}\nevidence: ${e.evidence}`;
}

// ---- 4. Proposer ----
export function proposerPrompt(stance: Stance, policies: string, entity: string, contexts: string): Prompt {
  return {
    system: `You are proposing the English rendering for ONE glossary entry in a Chinese→English novel
translation. Other translators are proposing independently; you will not see their answers.

Follow the book-wide policies. Propose the single rendering you would commit to for the whole
book, plus renderings for each alias, and note any rendering that should be BANNED because a
careless translator might produce it.

${STANCES[stance]}

POLICIES:
${policies}`,
    user: `ENTRY:
${entity}

CONTEXTS (Chinese, with paragraph IDs):
${contexts}`,
  };
}

export function formatProposal(p: Proposal): string {
  const al = p.alias_renderings.map((a) => `${a.source} → ${a.rendering}`).join(', ') || '(none)';
  return `rendering: ${p.rendering}; aliases: ${al}; banned: ${p.banned.join(', ') || '(none)'}; confidence: ${p.confidence}; rationale: ${p.rationale}`;
}

// ---- 5. Critic ----
export function criticPrompt(policies: string, entityAndContexts: string, a: string, b: string, c: string, glossarySoFar: string): Prompt {
  return {
    system: `Three translators proposed renderings for the same glossary entry. Their identities are
hidden. For each proposal, name its strongest point and its biggest risk across a whole
novel (repetition, ambiguity, collisions with other terms, policy violations). Do not pick
a winner.

POLICIES: ${policies}`,
    user: `ENTRY AND CONTEXTS: ${entityAndContexts}
PROPOSALS: A: ${a}  B: ${b}  C: ${c}
OTHER FROZEN ENTRIES (check for collisions): ${glossarySoFar}`,
  };
}

export function formatCritique(c: Critique): string {
  return c.critiques.map((x) => `${x.proposal}: strength: ${x.strength} risk: ${x.risk}`).join('\n') + (c.collisions.length ? `\ncollisions: ${c.collisions.join('; ')}` : '');
}

// ---- 6. Terminologist ----
export function terminologistPrompt(policies: string, glossarySoFar: string, entityAndContexts: string, proposals: string, critiques: string): Prompt {
  return {
    system: `You are the terminologist: the only role allowed to write the book's glossary. Decide the
final rendering for this entry. You may adopt a proposal, combine them, or write your own.

Your decision must:
- follow the book-wide policies
- not collide with another frozen entry (two different sources must not share a rendering)
- give a rendering for every alias
- list banned variants that a later check should flag
- give a rationale in one or two sentences a human reviewer could check

If the right rendering depends on context (the same characters mean different things in
different places), say so and give a rule for each context. If you cannot decide responsibly,
set needs_human=true and explain why.

POLICIES: ${policies}
FROZEN GLOSSARY: ${glossarySoFar}`,
    user: `ENTRY AND CONTEXTS: ${entityAndContexts}
PROPOSALS: ${proposals}
CRITIQUES: ${critiques}`,
  };
}

// ---- Rendering tagged text for downstream prompts ----
export function renderTaggedParagraph(p: TaggedChapter['paragraphs'][number]): string {
  return p.segments
    .map((s) => {
      if (s.type === 'narration') return `<narration>${s.text}</narration>`;
      const attrs = [s.speaker ? ` speaker="${s.speaker}"` : '', s.addressee ? ` to="${s.addressee}"` : '', s.address_form ? ` address="${s.address_form}"` : ''].join('');
      return `<${s.type}${attrs}>${s.text}</${s.type}>`;
    })
    .join('');
}

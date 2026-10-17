// Deterministic fake model, used when CRUSOE_API_KEY is unset (or FAKE_LLM=1).
// It understands the prompt formats our activities produce and returns schema-shaped JSON.
import type { ChatJsonRequest, ChatJsonRaw } from './llm';

const BLOCK_RE = /\[([0-9]{2}\.)?(p\d{3})\]\n([\s\S]*?)(?=\n\n\[(?:[0-9]{2}\.)?p\d{3}\]\n|$)/g;
const KNOWN_PEOPLE = ['沈澈', '陆楠', '周总', '师父', '师傅'];
const ADDRESS_FORMS: Record<string, string> = { 沈哥: '沈澈', 小鹿: '陆楠', 周总: '周总', 师父: '师父', 师傅: '师傅' };

function blocks(user: string): { ref: string; id: string; text: string }[] {
  const out: { ref: string; id: string; text: string }[] = [];
  // Per-call material ends at a trailing instruction line, if any (e.g. the tagger's "Reminder: ...").
  user = user.split(/\n\nReminder:/)[0];
  for (const m of user.matchAll(BLOCK_RE)) out.push({ ref: `${m[1] ?? ''}${m[2]}`, id: m[2], text: m[3].trim() });
  return out;
}

function fakeTag(user: string) {
  const paragraphs = blocks(user).map(({ id, text }) => {
    const segments: Record<string, unknown>[] = [];
    const re = /“[^”]*”/g;
    let last = 0;
    const narrationSpeaker = KNOWN_PEOPLE.find((n) => text.includes(n)) ?? 'unknown';
    for (const m of text.matchAll(re)) {
      if (m.index! > last) segments.push({ type: 'narration', text: text.slice(last, m.index), speaker: '', addressee: '', address_form: '' });
      const form = Object.keys(ADDRESS_FORMS).find((f) => m[0].includes(f)) ?? '';
      const addressee = form ? ADDRESS_FORMS[form] : '';
      const speaker = addressee && addressee !== narrationSpeaker ? narrationSpeaker : KNOWN_PEOPLE.find((n) => n !== addressee && text.includes(n)) ?? 'unknown';
      segments.push({ type: 'speech', text: m[0], speaker, addressee, address_form: form });
      last = m.index! + m[0].length;
    }
    if (last < text.length) segments.push({ type: 'narration', text: text.slice(last), speaker: '', addressee: '', address_form: '' });
    return { id, segments };
  });
  return { paragraphs };
}

function fakeExtract(user: string) {
  const candLines = (user.split('TEXT (paragraph IDs in brackets):')[0].match(/^(\S+)\s+\(×(\d+); ([^)]*)\)$/gm) ?? []) as string[];
  const items = candLines.map((line) => {
    const m = line.match(/^(\S+)\s+\(×\d+; ([^)]*)\)$/)!;
    const source = m[1];
    const type = source in ADDRESS_FORMS ? 'address_form' : KNOWN_PEOPLE.includes(source) ? 'person' : 'term';
    return { source, type, refers_to: source in ADDRESS_FORMS ? ADDRESS_FORMS[source] : '', paragraph_ids: m[2].split(', '), needs_fixed_rendering: true, reason: 'fake: frequent candidate' };
  });
  // Make sure the people and address forms show up even if frequency analysis missed them.
  const seen = new Set(items.map((i) => i.source));
  const text = user.split('TEXT (paragraph IDs in brackets):')[1] ?? '';
  for (const s of [...KNOWN_PEOPLE, ...Object.keys(ADDRESS_FORMS)]) {
    if (!seen.has(s) && text.includes(s)) {
      const ids = blocks(text).filter((b) => b.text.includes(s)).map((b) => b.ref);
      items.push({ source: s, type: s in ADDRESS_FORMS && !KNOWN_PEOPLE.includes(s) ? 'address_form' : 'person', refers_to: s in ADDRESS_FORMS ? ADDRESS_FORMS[s] : '', paragraph_ids: ids, needs_fixed_rendering: true, reason: 'fake: known name' });
    }
  }
  return { items, rejected_candidates: [] };
}

function fakeGroup(user: string) {
  const itemSources = Array.from(user.matchAll(/^ITEM: (\S+) \((\w+)\)/gm)).map((m) => ({ source: m[1], type: m[2] }));
  const table = Array.from(user.matchAll(/^(\S+) → (\S+): (\S+)/gm)).map((m) => ({ who: m[1], whom: m[2], form: m[3] }));
  const aliasOf = new Map<string, { target: string; used_by: string }>();
  for (const t of table) if (t.form !== t.whom) aliasOf.set(t.form, { target: t.whom, used_by: t.who });
  const entities = new Map<string, { canonical_source: string; aliases: { source: string; kind: string; used_by: string }[]; type: string; evidence: string }>();
  for (const it of itemSources) {
    const a = aliasOf.get(it.source);
    if (a && itemSources.some((x) => x.source === a.target)) continue;
    entities.set(it.source, { canonical_source: it.source, aliases: [], type: it.type, evidence: 'fake: canonical item' });
  }
  for (const it of itemSources) {
    const a = aliasOf.get(it.source);
    if (a && entities.has(a.target)) entities.get(a.target)!.aliases.push({ source: it.source, kind: 'address', used_by: a.used_by });
  }
  return {
    entities: Array.from(entities.values()),
    kept_separate: [{ sources: ['师父', '师傅'], reason: 'fake: homophones with different meanings are never merged' }].filter((k) => k.sources.every((s) => itemSources.some((x) => x.source === s))),
  };
}

function fakePolicies() {
  return {
    policies: [
      { topic: 'Personal names', rule: 'Pinyin, surname first, no tone marks.', example_source: '沈澈', example_target: 'Shen Che' },
      { topic: 'Forms of address', rule: 'Adapt to natural English address; keep nicknames romanized.', example_source: '沈哥', example_target: 'Shen' },
      { topic: 'Titles', rule: 'Translate workplace titles.', example_source: '周总', example_target: 'Director Zhou' },
      { topic: 'Invented names', rule: 'Translate meaning when it is meaningful.', example_source: '夜航', example_target: 'Night Voyage' },
      { topic: 'Spelling', rule: 'US spelling; hyphenate compound modifiers.', example_source: '灰名单', example_target: 'gray list' },
      { topic: 'Register', rule: 'Past tense narration, contemporary natural dialogue.', example_source: '—', example_target: '—' },
    ],
  };
}

/** Stable, CJK-free placeholder rendering for a source string. */
function fakeRender(source: string, variant = ''): string {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `Term${variant}-${h.toString(36)}`;
}

function fakePropose(system: string, user: string) {
  const source = user.match(/source: (\S+)/)?.[1] ?? 'X';
  const type = user.match(/type: (\S+)/)?.[1] ?? 'term';
  const aliases = Array.from(user.matchAll(/(\S+) \[(?:nickname|address|title|variant)/g)).map((m) => m[1]);
  const genre = system.includes('conventionally render');
  const readability = system.includes('English-speaking reader');
  // People: all three agree. Orgs/places: readability adds an article (agreement only after normalization).
  // Everything else: the genre stance differs, forcing a debate.
  let rendering = fakeRender(source);
  if (type === 'org' || type === 'place') rendering = readability ? `the ${rendering}` : rendering;
  else if (type !== 'person' && genre) rendering = fakeRender(source, 'G');
  return { rendering, alias_renderings: aliases.map((a) => ({ source: a, rendering: fakeRender(a) })), banned: [`Bad-${fakeRender(source)}`, rendering], confidence: 0.8, rationale: 'fake proposal' };
}

function fakeCritique() {
  return { critiques: ['A', 'B', 'C'].map((p) => ({ proposal: p, strength: 'fake strength', risk: 'fake risk' })), collisions: [] };
}

function fakeDecide(user: string, system = '') {
  const source = user.match(/source: (\S+)/)?.[1] ?? 'X';
  let first = user.match(/rendering: ([^;]+);/)?.[1] ?? fakeRender(source);
  // Honor nested-term constraints ("MUST contain "X" verbatim") like a cooperative terminologist.
  for (const m of system.matchAll(/MUST contain "([^"]+)" verbatim/g)) if (!first.includes(m[1])) first = `${first} ${m[1]}`;
  // Deliberately omit alias renderings so the code-side fill is exercised offline.
  return { source, rendering: first, alias_renderings: [], banned: [`Bad-${fakeRender(source)}`], context_rules: [{ when: '', rendering: '' }], rationale: 'fake: adopted proposal A', confidence: 0.7, needs_human: false };
}

export async function fakeChatJson(req: ChatJsonRequest): Promise<ChatJsonRaw> {
  let value: unknown;
  switch (req.schemaName) {
    case 'translation': {
      // Tagged input: strip the XML-style tags so the fake output has no tags, like the real translator.
      const revised = /A reviewer flagged these issues/.test(req.user);
      const paras = blocks(req.user.split('\n\nA reviewer flagged')[0]).map((b) => ({ id: b.id, text: `(fake-en${revised ? ', revised' : ''}) ${b.text.replace(/<[^>]+>/g, '')}` }));
      value = { paragraphs: paras, new_terms: [] };
      break;
    }
    case 'tagging':
      value = fakeTag(req.user);
      break;
    case 'extraction':
      value = fakeExtract(req.user);
      break;
    case 'alias_groups':
      value = fakeGroup(req.user);
      break;
    case 'policies':
      value = fakePolicies();
      break;
    case 'proposal':
      value = fakePropose(req.system, req.user);
      break;
    case 'critique':
      value = fakeCritique();
      break;
    case 'terminologist':
      value = fakeDecide(req.user, req.system);
      break;
    case 'review': {
      // Round 1: ask for one major fix on the first paragraph; after that approve.
      const alreadyRevised = /"round":\s*[1-9]/.test(req.user) || req.user.includes('(fake-en, revised)');
      value = alreadyRevised
        ? { verdict: 'approve', issues: [], term_disputes: [] }
        : { verdict: 'revise', issues: [{ paragraph_id: 'p001', category: 'fluency', severity: 'major', quote: '(fake-en)', suggestion: 'tighten' }], term_disputes: [] };
      break;
    }
    default:
      throw new Error(`fake model: no handler for schema "${req.schemaName}"`);
  }
  const content = JSON.stringify(value);
  return {
    content,
    finishReason: 'stop',
    usage: {
      model: `fake:${req.model}`,
      prompt_tokens: Math.ceil((req.system.length + req.user.length) / 3),
      completion_tokens: Math.ceil(content.length / 3),
      cached_tokens: Math.floor(req.system.length / 3),
    },
  };
}

export async function fakeChatText(req: ChatJsonRequest): Promise<ChatJsonRaw> {
  const content = req.user
    .split(/\n\s*\n|\n/)
    .filter((l) => l.trim())
    .map((l) => `(fake-en) ${l.trim()}`)
    .join('\n\n');
  return { content, finishReason: 'stop', usage: { model: `fake:${req.model}`, prompt_tokens: Math.ceil(req.user.length / 3), completion_tokens: Math.ceil(content.length / 3), cached_tokens: 0 } };
}

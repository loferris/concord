import { z } from 'zod';

// NOTE: prompts.md marks some fields with `?`. Strict JSON-schema output requires every property to be
// present. `.nullable()` produces `anyOf [type, null]`, which on Crusoe's Nemotron Super guided decoding
// triggered endless-whitespace loops right at those fields (measured Oct 17). Optional strings are
// therefore encoded as plain strings where "" means "none"; code converts "" to null after parsing.

export const TranslationSchema = z.object({
  paragraphs: z.array(
    z.object({
      id: z.string().describe('Paragraph id copied exactly from the source, e.g. p001'),
      text: z.string().describe('English translation of that paragraph'),
    }),
  ),
  new_terms: z.array(
    z.object({
      source: z.string().describe('Recurring name or setting term not in the glossary, exact source string'),
      paragraph_id: z.string(),
      provisional_rendering: z.string(),
    }),
  ),
});
export type Translation = z.infer<typeof TranslationSchema>;

export const UsageSchema = z.object({
  model: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_tokens: z.number().nullable().describe('null when the provider does not report prompt_tokens_details'),
  created_cache_tokens: z.number().nullable().optional().describe('DeepSeek on Crusoe: prefix tokens newly written to cache'),
  reasoning_tokens: z.number().nullable().optional(),
  attempts: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---- 0. Tagger -------------------------------------------------------------------------------
export const SegmentTypeSchema = z.enum(['narration', 'speech', 'thought', 'text_message']);
export const TaggedChapterSchema = z.object({
  paragraphs: z.array(
    z.object({
      id: z.string().describe('Paragraph id copied exactly from the source, e.g. p001'),
      segments: z.array(
        z.object({
          type: SegmentTypeSchema,
          text: z.string().describe('Exact original Chinese substring, untranslated and unmodified'),
          speaker: z.string().describe('Who speaks / thinks / writes, named as the narration names them; "unknown" if unclear; "" for narration'),
          addressee: z.string().describe('Who is addressed, when clear; otherwise ""'),
          address_form: z.string().describe('Form of address used in this segment (沈哥, 小鹿, 师父...), in Chinese, or ""'),
        }),
      ),
    }),
  ),
});
export type TaggedChapter = z.infer<typeof TaggedChapterSchema>;
export type TaggedSegment = TaggedChapter['paragraphs'][number]['segments'][number];

// ---- 1. Extractor ----------------------------------------------------------------------------
export const TermTypeSchema = z.enum(['person', 'address_form', 'title', 'org', 'product', 'place', 'term', 'phrase', 'homograph']);
export const ExtractionSchema = z.object({
  items: z.array(
    z.object({
      source: z.string().describe('Exact source string as it appears in the text'),
      type: TermTypeSchema,
      refers_to: z.string().describe('If this is a form of address or title for a person, which person; otherwise ""'),
      paragraph_ids: z.array(z.string()).describe('Paragraph ids where it appears, e.g. 01.p003'),
      needs_fixed_rendering: z.boolean(),
      reason: z.string(),
    }),
  ),
  rejected_candidates: z.array(z.object({ source: z.string(), reason: z.string() })),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedItem = Extraction['items'][number];

// ---- 2. Alias grouper ------------------------------------------------------------------------
export const AliasKindSchema = z.enum(['nickname', 'address', 'title', 'variant']);
export const AliasGroupsSchema = z.object({
  entities: z.array(
    z.object({
      canonical_source: z.string().describe('The full / canonical source form of the entity'),
      aliases: z.array(
        z.object({
          source: z.string(),
          kind: AliasKindSchema,
          used_by: z.string().describe('Who uses this form of address, if it is speaker-specific; otherwise ""'),
        }),
      ),
      type: TermTypeSchema,
      evidence: z.string(),
    }),
  ),
  kept_separate: z.array(z.object({ sources: z.array(z.string()), reason: z.string() })),
});
export type AliasGroups = z.infer<typeof AliasGroupsSchema>;
export type Entity = AliasGroups['entities'][number];

// ---- 3. Policies -----------------------------------------------------------------------------
export const PoliciesSchema = z.object({
  policies: z.array(z.object({ topic: z.string(), rule: z.string(), example_source: z.string(), example_target: z.string() })),
});
export type Policies = z.infer<typeof PoliciesSchema>;

// ---- 4. Proposer -----------------------------------------------------------------------------
export const AliasRenderingSchema = z.object({ source: z.string(), rendering: z.string() });
export const ProposalSchema = z.object({
  rendering: z.string(),
  alias_renderings: z.array(AliasRenderingSchema),
  banned: z.array(z.string()),
  confidence: z.number().min(0).max(1).describe('0-1'),
  rationale: z.string().describe('At most two sentences'),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---- 5. Critic -------------------------------------------------------------------------------
export const CritiqueSchema = z.object({
  critiques: z.array(z.object({ proposal: z.enum(['A', 'B', 'C']), strength: z.string(), risk: z.string() })),
  collisions: z.array(z.string()),
});
export type Critique = z.infer<typeof CritiqueSchema>;

// ---- 6. Terminologist ------------------------------------------------------------------------
export const TerminologistSchema = z.object({
  source: z.string(),
  rendering: z.string(),
  alias_renderings: z.array(AliasRenderingSchema),
  banned: z.array(z.string()),
  context_rules: z.array(z.object({ when: z.string(), rendering: z.string() })).describe('Only when the rendering depends on context; otherwise an empty array'),
  rationale: z.string(),
  confidence: z.number().min(0).max(1).describe('0-1'),
  needs_human: z.boolean(),
});
export type TerminologistDecision = z.infer<typeof TerminologistSchema>;

// ---- 8. Reviewer ----------------------------------------------------------------------------
export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise']).describe('approve if there are no critical or major issues, otherwise revise'),
  issues: z.array(
    z.object({
      paragraph_id: z.string(),
      category: z.enum(['accuracy', 'fluency', 'register']),
      severity: z.enum(['critical', 'major', 'minor']),
      quote: z.string().describe('The problem text, quoted from the translation'),
      suggestion: z.string(),
    }),
  ),
  term_disputes: z.array(z.object({ source: z.string(), current_rendering: z.string(), proposed: z.string(), reason: z.string() })),
});
export type Review = z.infer<typeof ReviewSchema>;

// ---- Glossary (code-side, written by BookWorkflow) ------------------------------------------
export const GlossaryEntrySchema = z.object({
  source: z.string(),
  type: TermTypeSchema,
  rendering: z.string(),
  aliases: z.array(z.object({ source: z.string(), kind: AliasKindSchema, used_by: z.string() })),
  alias_renderings: z.array(AliasRenderingSchema),
  banned: z.array(z.string()),
  context_rules: z.array(z.object({ when: z.string(), rendering: z.string() })),
  decided_by: z.enum(['agreement', 'terminologist', 'human']),
  rationale: z.string(),
  confidence: z.number(),
  needs_human: z.boolean(),
  needs_human_reason: z.string().nullable(),
  /** Set by `cli resolve`: which needs_human flag or reviewer dispute this human decision answers. */
  resolved_from: z.string().nullable().optional(),
  /** Deterministic fixes applied by code after the model decided (audit trail). */
  code_notes: z.array(z.string()),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;
export const GlossarySchema = z.object({
  version: z.number(),
  runId: z.string(),
  entries: z.array(GlossaryEntrySchema),
});
export type Glossary = z.infer<typeof GlossarySchema>;

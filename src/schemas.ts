import { z } from 'zod';

export const TranslationSchema = z.object({
  paragraphs: z.array(
    z.object({
      id: z.string().describe('Paragraph id copied exactly from the source, e.g. p001'),
      text: z.string().describe('English translation of that paragraph'),
    }),
  ),
});
export type Translation = z.infer<typeof TranslationSchema>;

export const UsageSchema = z.object({
  model: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cached_tokens: z.number().nullable().describe('null when the provider does not report prompt_tokens_details'),
  attempts: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

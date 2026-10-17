import type { z } from 'zod';
import type { TermTypeSchema } from '../schemas';
export type TermType = z.infer<typeof TermTypeSchema>;

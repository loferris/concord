// Shared constants. Safe to import from workflows (no I/O, no SDK imports).
export const MODELS = {
  /** Output: chapter translation. Cheapest cached input in the catalog; thinking off. */
  translator: 'deepseek-ai/DeepSeek-V4.1-Flash',
  /** Tagger: verbatim copy + labels over Chinese text. Bench Oct 17: DeepSeek 6/6 exact vs Super 3/6 (loops). */
  tagger: 'deepseek-ai/DeepSeek-V4.1-Flash',
  /** Coordination: terminologist, reviewer, proposers. */
  smart: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  /** Extraction: reads the whole book in one call (1M ctx) and spreads load onto a third rate limit. */
  extractor: 'nvidia/Nemotron-3.5-Lightning-30B-A3B',
  /** Review: third family, thinking ON (see docs/prompts.md table). */
  reviewer: 'zai-org/GLM-5.3-Flash',
} as const;

export const TASK_QUEUES = {
  workflows: 'workflows',
  fast: 'fast', // translator (DeepSeek V4.1 Flash)
  smart: 'smart', // terminologist, reviewer, proposers (Super)
} as const;

export const EVAL_SEED = 20261017;
export const RUN_DATA_DIR = 'run-data';

// Shared constants. Safe to import from workflows (no I/O, no SDK imports).
export const MODELS = {
  /** Output: chapter translation. Cheapest cached input in the catalog; thinking off. */
  translator: 'deepseek-ai/DeepSeek-V4.1-Flash',
  /** Coordination + extraction: terminologist, reviewer, proposers, glossary extraction. */
  smart: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
} as const;

export const TASK_QUEUES = {
  workflows: 'workflows',
  fast: 'fast', // translator (DeepSeek V4.1 Flash)
  smart: 'smart', // terminologist, reviewer, proposers (Super)
} as const;

export const EVAL_SEED = 20261017;
export const RUN_DATA_DIR = 'run-data';

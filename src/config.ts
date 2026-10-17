// Shared constants. Safe to import from workflows (no I/O, no SDK imports).
export const MODELS = {
  translator: 'nvidia/Nemotron-3.5-Lightning-30B-A3B',
  smart: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
} as const;

export const TASK_QUEUES = {
  workflows: 'workflows',
  fast: 'fast', // translator (Lightning)
  smart: 'smart', // terminologist, reviewer, proposers (Super)
} as const;

export const EVAL_SEED = 20261017;
export const RUN_DATA_DIR = 'run-data';

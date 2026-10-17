import { Context, heartbeat } from '@temporalio/activity';
import { EVAL_SEED, MODELS } from '../config';
import { basename, extname } from 'node:path';

export function chapterNameOf(path: string): string {
  return basename(path, extname(path));
}

/** Run fn while heartbeating every 5s so the workflow can detect a dead worker (heartbeatTimeout 15s). */
export async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => heartbeat(), 5_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Fixed seed on the first attempt (reproducible evals); perturbed on retries so a retry is not a replay. */
export function attemptSeed(): number {
  let attempt = 1;
  try {
    attempt = Context.current().info.attempt;
  } catch {
    /* outside an activity (bench scripts) */
  }
  return EVAL_SEED + (attempt - 1);
}

export function currentAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
}

/**
 * Primary model for the first attempts, fallback afterwards. Nemotron Super's guided decoding sometimes
 * degenerates into an endless-whitespace loop on a given input (measured Oct 17); retrying the same model
 * with a new seed rarely escapes it, so later attempts switch family. Logged; usage.model records it.
 */
export function modelForAttempt(primary: string, fallback: string = MODELS.translator, fromAttempt = 3): string {
  const attempt = currentAttempt();
  const model = attempt >= fromAttempt ? fallback : primary;
  if (model !== primary) console.log(`[fallback] attempt ${attempt}: using ${model} instead of ${primary}`);
  return model;
}

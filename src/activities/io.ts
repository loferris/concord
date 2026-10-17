import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { RUN_DATA_DIR } from '../config';

/** Make an arbitrary string (e.g. a model-produced term) safe to use as one path segment. */
export function safeSegment(s: string): string {
  const cleaned = s.replace(/[\/\\\0-\x1f]/g, '_').replace(/^\.+$/, '_').trim();
  return cleaned || '_';
}

/** Path under run-data/<runId>/...; every segment is sanitized and the result must stay inside the run folder. */
export function runDir(runId: string, ...parts: string[]): string {
  const base = resolve(RUN_DATA_DIR, safeSegment(runId));
  const full = resolve(base, ...parts.map(safeSegment));
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`path escapes run folder: ${parts.join('/')}`);
  return join(RUN_DATA_DIR, safeSegment(runId), ...parts.map(safeSegment));
}

/** Atomic write: tmp file in the same dir, then rename. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

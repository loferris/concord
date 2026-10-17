import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RUN_DATA_DIR } from '../config';

export function runDir(runId: string, ...parts: string[]): string {
  return join(RUN_DATA_DIR, runId, ...parts);
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

// Load .env into process.env (Node >= 20.12). Never log values.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(): void {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (loader) loader.call(process, p);
}

export function useFakeModel(): boolean {
  return !process.env.CRUSOE_API_KEY || process.env.FAKE_LLM === '1';
}

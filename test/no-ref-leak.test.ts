import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The answer key is for the eval only. Nothing that builds a prompt or runs as an activity may read it.
describe('ref/ is never read by prompts, activities or workflows', () => {
  const files = ['src/prompts.ts', 'src/workflows.ts', 'src/llm.ts', 'src/fake.ts', 'src/extract.ts', 'src/checks.ts', ...readdirSync('src/activities').map((f) => `src/activities/${f}`)];
  for (const f of files) {
    it(`${f} does not mention ref/`, () => {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/ref\/|english-reference/);
    });
  }
  it('only src/eval.ts, src/cli.ts and src/report.ts (eval output) reference the answer key', () => {
    const all = readdirSync('src').filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`);
    const offenders = all.filter((f) => /ref\/|english-reference/.test(readFileSync(f, 'utf8')) && !['src/eval.ts', 'src/cli.ts', 'src/report.ts'].includes(f));
    expect(offenders).toEqual([]);
  });
});

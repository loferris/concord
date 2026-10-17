// Recompute address-forms.json (per chapter + book-wide) from existing tagged.json files, in code only.
// Usage: bunx tsx scripts/recompute-address-forms.ts <runId>
import { readFile, readdir } from 'node:fs/promises';
import { deriveAddressForms, formatAddressForms, normalizeSegments, type AddressForm } from '../src/activities/tag';
import { writeJsonAtomic } from '../src/activities/io';

async function main() {
  const runId = process.argv[2];
  const dir = `run-data/${runId}/chapters`;
  const all: AddressForm[] = [];
  for (const ch of (await readdir(dir)).sort()) {
    const tagged = JSON.parse(await readFile(`${dir}/${ch}/tagged.json`, 'utf8'));
    const normalized = normalizeSegments(tagged);
    const rows = deriveAddressForms(normalized, ch);
    await writeJsonAtomic(`${dir}/${ch}/tagged.json`, { ...tagged, ...normalized });
    await writeJsonAtomic(`${dir}/${ch}/address-forms.json`, rows);
    all.push(...rows);
  }
  const merged = new Map<string, AddressForm>();
  for (const f of all) {
    const k = `${f.speaker}|${f.addressee}|${f.form}`;
    const cur = merged.get(k);
    if (cur) { cur.count += f.count; cur.paragraph_ids.push(...f.paragraph_ids); } else merged.set(k, { ...f, paragraph_ids: [...f.paragraph_ids] });
  }
  const book = Array.from(merged.values()).sort((a, b) => b.count - a.count);
  await writeJsonAtomic(`run-data/${runId}/glossary/address-forms.json`, book);
  console.log(formatAddressForms(book));
}
main();

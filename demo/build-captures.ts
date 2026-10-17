// Package captured demo output (demo-capture/*.txt, *.png) into demo/captures.js for motion.html.
//
//   npx tsx demo/build-captures.ts [captureDir]     # default: demo-capture (repo root)
//
// Text is used exactly as captured (ANSI codes stripped). Start a capture file with a "$ <command>" line
// to show the exact command that produced it. Missing files are skipped, and the video
// falls back to a "cut to footage" slate for that cue. Edit SPECS to change labels or highlights.
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.resolve(process.argv[2] ?? path.join(dir, '..', 'demo-capture'));

interface Spec { file: string; label: string; cmd: string; highlight?: string; rows?: number; reveal?: boolean; images?: string }
const SPECS: Record<string, Spec> = {
  baseline: { file: 'baseline.txt', label: 'Baseline: one prompt per chapter, no glossary', cmd: 'grep -n -i "mentor\\|master\\|shifu" <baseline ch2, ch3>', highlight: 'mentor|master|shifu' },
  glossary: { file: 'glossary.txt', label: 'Glossary: human decisions marked ✎', cmd: 'cli glossary', highlight: '✎|driver|Review Team|Guanlan Data' },
  incremental: { file: 'incremental.txt', label: 'The glossary grows: one version per chapter', cmd: 'cli growth', highlight: '阿澈|师傅|alias|needs_human' },
  kill: { file: 'kill-resume.txt', label: 'kill -9 mid-run, then resume', cmd: 'scripts/kill-resume.sh', highlight: 'kill|Heartbeat timeout|attempt 2|restart|resum|completed', rows: 20, reveal: true, images: '^temporal-[23].*\\.png$' },
  eval: { file: 'eval.txt', label: 'Same writer model, with and without the team', cmd: 'cli eval --ref', highlight: 'term consistency|banned' , rows: 22 },
};

const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
const out: Record<string, unknown> = {};
const files = existsSync(capDir) ? readdirSync(capDir) : [];
for (const [key, spec] of Object.entries(SPECS)) {
  const p = path.join(capDir, spec.file);
  if (!existsSync(p)) { console.log(`  skip ${key}: no ${spec.file}`); continue; }
  let text = stripAnsi(readFileSync(p, 'utf8')).replace(/\s+$/, '');
  // A first line starting with "$ " is the exact command that produced the capture; show it as the command.
  let cmd = spec.cmd;
  const first = text.split('\n', 1)[0];
  if (first.startsWith('$ ')) { cmd = first.slice(2); text = text.slice(first.length).replace(/^\n/, ''); }
  const images = spec.images
    ? files.filter((f) => new RegExp(spec.images!).test(f)).sort().map((f) => path.relative(dir, path.join(capDir, f)).split(path.sep).join('/'))
    : [];
  out[key] = { label: spec.label, cmd, text, highlight: spec.highlight, rows: spec.rows, reveal: spec.reveal, images };
  console.log(`  ${key}: ${text.split('\n').length} lines${images.length ? `, ${images.length} screenshots` : ''}`);
}
writeFileSync(path.join(dir, 'captures.js'), `window.CAPTURES = ${JSON.stringify(out)};\n`);
console.log(`wrote demo/captures.js (${Object.keys(out).length} captures from ${capDir})`);

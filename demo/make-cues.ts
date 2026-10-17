// Generate voice.mp3 + cue timings from narration.txt with ElevenLabs.
//
//   read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
//   export ELEVENLABS_VOICE_ID='<voice id from the ElevenLabs voice library>'
//   npx tsx demo/make-cues.ts            # writes demo/voice.mp3, demo/cues.json, demo/cues.js
//   NARRATION=narration-incremental.txt npx tsx demo/make-cues.ts   # the incremental version
//
// Optional: ELEVENLABS_MODEL (default eleven_multilingual_v2).
// cues.js is loaded by motion.html via a <script> tag so it works from file:// too.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const key = process.env.ELEVENLABS_API_KEY;
const voice = process.env.ELEVENLABS_VOICE_ID;
const model = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
if (!key || !voice) {
  console.error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID first.');
  process.exit(1);
}

// 1. Parse narration: drop comments, pull out [[cue]] markers with their offsets in the spoken text.
const narrationFile = process.env.NARRATION ?? 'narration.txt';
const raw = readFileSync(path.join(dir, narrationFile), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n').trim();

const markers: { name: string; idx: number }[] = [];
let text = '';
let last = 0;
for (const m of raw.matchAll(/\[\[(\w+)\]\]\s*/g)) {
  text += raw.slice(last, m.index);
  markers.push({ name: m[1], idx: text.length });
  last = m.index! + m[0].length;
}
text += raw.slice(last);

const leftover = text.match(/\[[^\]]*\]/g);
if (leftover) {
  console.error(`Fill these placeholders in narration.txt first: ${leftover.join(', ')}`);
  process.exit(1);
}
const words = text.split(/\s+/).filter(Boolean).length;
console.log(`${words} words, ${markers.length} cues: ${markers.map((m) => m.name).join(', ')}`);

// 2. Synthesize with character-level timestamps.
const res = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`,
  {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  },
);
if (!res.ok) {
  console.error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}
const body = (await res.json()) as {
  audio_base64: string;
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
};
writeFileSync(path.join(dir, 'voice.mp3'), Buffer.from(body.audio_base64, 'base64'));

// 3. Map each marker to a time. Match the next few words after the marker in the aligned text,
//    since the alignment can differ slightly from the input (whitespace, normalization).
const al = body.alignment;
const joined = al.characters.join('');
const duration = al.character_end_times_seconds.at(-1) ?? 0;
let cursor = 0;
const cues = markers.map(({ name, idx }) => {
  const anchor = text.slice(idx, idx + 24).trim();
  let pos = joined.indexOf(anchor, cursor);
  if (pos < 0) {
    pos = Math.round((idx / text.length) * joined.length);
    console.warn(`  cue "${name}": anchor not found, estimating`);
  }
  cursor = pos;
  return { name, t: Math.round(al.character_start_times_seconds[Math.min(pos, joined.length - 1)] * 1000) / 1000 };
});

const out = { audio: 'voice.mp3', duration: Math.round(duration * 1000) / 1000, cues };
writeFileSync(path.join(dir, 'cues.json'), JSON.stringify(out, null, 2) + '\n');
writeFileSync(path.join(dir, 'cues.js'), `window.CUES = ${JSON.stringify(out)};\n`);
for (const c of cues) console.log(`  ${c.t.toFixed(2).padStart(6)}s  ${c.name}`);
console.log(`  ${duration.toFixed(2).padStart(6)}s  end${duration > 62 ? '  (over 60s: trim a line)' : ''}`);

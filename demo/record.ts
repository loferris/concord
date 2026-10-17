// Render motion.html + voice.mp3 to an MP4, frame by frame, with exact sync.
//
//   npx playwright install chromium     # once
//   npx tsx demo/record.ts              # writes demo/out/concord-motion.mp4 (needs ffmpeg)
//   DEBUG=1 npx tsx demo/record.ts      # same, with the cue clock burned into the corner
//
// Opens the page headless with ?render, then for each frame at 30 fps calls renderAt(t), which
// fires the cue steps due by t and seeks every CSS transition to its age at t, and pipes a
// screenshot to ffmpeg. No real-time capture, so a slow machine only makes it take longer.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, 'out');
mkdirSync(outDir, { recursive: true });
const fps = 30;
const size = { width: 1920, height: 1080 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(dir, 'motion.html')).href + (process.env.DEBUG ? '?render&debug' : '?render'));
await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 15_000 });
await page.evaluate(() => document.fonts.ready);
const duration: number = await page.evaluate(() => (window as any).CUES.duration);
const frames = Math.ceil((duration + 1) * fps);

const mp4 = path.join(outDir, 'concord-motion.mp4');
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-i', path.join(dir, 'voice.mp3'), '-map', '0:v', '-map', '1:a', '-af', 'apad',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-shortest', mp4,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => (window as any).renderAt(t), i / fps);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(jpg)) await once(ff.stdin, 'drain');
  if (i % (fps * 10) === 0) console.log(`  ${(i / fps).toFixed(0)}s / ${duration.toFixed(0)}s`);
}
ff.stdin.end();
const [code] = await once(ff, 'close');
await browser.close();
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(`wrote ${mp4}: ${frames} frames in ${((Date.now() - started) / 1000).toFixed(0)}s`);

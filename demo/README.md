# demo/: the 1-minute video, generated from the repo

The demo video is built by code from the narration script and real captured output. No hand editing.

```
demo/narration.txt         the script, with [[cue]] markers (narration-incremental.txt for incremental mode)
demo-capture/*.txt, *.png  real command output and Temporal UI screenshots
        │
        ├─ make-cues.ts       ElevenLabs text-to-speech with timestamps → voice.mp3, cues.js
        ├─ build-captures.ts  demo-capture/ → captures.js
        └─ record.ts          renders motion.html frame by frame, muxes the voice → out/concord-motion.mp4
```

## Run it

```sh
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
export ELEVENLABS_VOICE_ID='<voice id>'
npx tsx demo/make-cues.ts          # NARRATION=narration-incremental.txt for the incremental version
npx tsx demo/build-captures.ts     # reads demo-capture/ at the repo root
npx tsx demo/record.ts             # needs ffmpeg and `npx playwright install chromium`
```

`DEBUG=1 npx tsx demo/record.ts` burns the cue clock into the corner for checking sync.

## Captures

| File | Command | Cue |
|---|---|---|
| `baseline.txt` | `grep -n -i -C2 "master\|mentor"` on the canonical baseline's chapter 3 | `baseline` |
| `glossary.txt` | `cli glossary <glossaryRunId> 3` | `glossary` |
| `incremental.txt` | the growth table from `scripts/incremental-demo.sh` | `growtable` |
| `kill-resume.txt` | `scripts/kill-resume.sh <glossaryRunId>`, each line prefixed with elapsed seconds | `kill` |
| `temporal-2-*.png`, `temporal-3-*.png` | Temporal UI at 1920×1080: attempt 2 after the kill, then completed | `kill` |
| `eval.txt` | `cli eval <runId> <glossaryRunId> --ref` | `ablation` |

Capture with `NO_COLOR=1 COLUMNS=100`. Text is rendered exactly as captured; a missing file falls back to a
"cut to footage" slate for that cue. Labels and highlight patterns live in `SPECS` in `build-captures.ts`.

## Notes

- Animated scenes are marked "schematic" on screen; captured scenes are marked "real output".
- The voice is ElevenLabs. The narration spells some names phonetically for the voice.
- `ref/english-reference.md` is never read here.

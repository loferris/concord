# Committed demo outputs

`run-data/` is gitignored; these are copies of the two runs shown in the demo.

- `batch-20261017-213120-j30v/`: whole-book run against glossary v3 (run `20261017-205002-c4sg` + three human
  resolutions). `report.html` (self-contained), `eval.txt` (3-column ablation + reference eval),
  `glossary.v2.json` (agents only) / `glossary.v3.json` (after `cli resolve`), `policies.json`,
  `0N.en.txt` final translations, `0N.baseline.en.txt` one-prompt baselines.
- `incremental-inc-demo-3/`: chapters added one at a time; `glossary.v1..3.json` (agents), `glossary.v4.json`
  (after `cli resolve 师傅 driver`), `changelog.json`, `growth.txt`, `eval.txt` (with `--hits`), `report.html`,
  `0N.en.txt` (03 re-translated against v4).
- `kill-resume-demo.log`: transcript of `scripts/kill-resume.sh` (worker killed mid-call, run resumed).

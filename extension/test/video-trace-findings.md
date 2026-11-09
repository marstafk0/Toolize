# Ordinary video playback trace (2026-11-08)

Chromium/Playwright with the isolated dev extension, `--enable-unsafe-webgpu`,
balanced sensitivity and safe reveal. Both NSFWJS MobileNetV2 and the safety model
ran. Each successful route was observed for 60 seconds, recording every sampled
frame's numeric scores/window and the popup's `chrome.storage.session.tabVerdicts`.
No screenshots, extracted frame files or explicit media were used.

The sample is 12 playback routes covering 10 distinct ordinary videos: music,
cooking, a vlog, gaming, nature, Blender animation and a public talk, with two
videos revisited through Shorts routes. The news ID was unavailable; Google's
sample MP4 bucket returned HTTP 403. An ordinary MDN flower MP4, served by the
trace's local test server, completed the sample. These are individual playback
runs with adaptive sampling; their score distributions are not model accuracy
estimates. Network timing and sampled positions can differ between runs.

## Result

| Measure | Before | After |
| --- | ---: | ---: |
| Playback routes | 12 | 12 |
| Routes with a model-blocked verdict at least once | 4 | 5 |
| Routes blurred after first being shown | 2 | 1 |
| Blur transitions after first being shown | 4 | 1 |
| All transitions to blocked | 7 | 5 |
| Obviously explicit shortcut transitions | 7 | 0 |
| Two-of-three transitions | 0 | 1 |
| Unshown doubtful/flagged transitions | 0 | 4 |
| Sampled frames | 195 | 192 |

"Blocked" excludes the expected pending CSS blur before classification. Rule
counts describe transitions recorded in the popup log, not subsequent frames
waiting for a clean streak while the verdict remains blocked.

To separate policy changes from live sampling variation, the same 195 baseline
score vectors were also replayed through the actual watcher/policy sources from
baseline commit `c5fc71b898e64f46b62a2b5aa376866d89339192` and the final sources.
With identical scores: mid-watch transitions **4 -> 1**, immediate-shortcut
transitions **7 -> 0**, and routes ever blocked **4 -> 4**. This replay exercises
the policy/window code with recorded predictions; it does not rerun inference.

The live after run still falsely blocked the music route `dTAAsCNK7RA` through
two-of-three confirmation, and initially blocked gaming `MmB9b5njVbA`, music
`fJ9rUzIMcZQ` and animation `aqz-KE-bpKQ` / `YE7VzlLtp-4` before first reveal.
The other seven routes stayed clear. The extra affected route versus the baseline
was a startup score spike; this policy change removes the safety-only immediate
bypass, while remaining startup and repeated-score false positives still need
the model/input investigation. It does not establish improved overall model accuracy.

Before the fix, music (`dTAAsCNK7RA`), gaming (`MmB9b5njVbA`), music
(`fJ9rUzIMcZQ`) and animation (`YE7VzlLtp-4`) received blocked verdicts. Every
triggering frame had NSFWJS porn+hentai+sexy below 0.194. Three separate mid-watch
blur transitions in the first music video had safety 0.945, 0.965 and 0.932.

## Rule and evidence

Immediate video blur now requires **safety > 0.97 and an actual NSFWJS flag** at
the selected preset (balanced: porn > 0.55, hentai > 0.55 or sexy > 0.75).
An initial trial using safety > 0.97 and NSFWJS porn+hentai+sexy > 0.3 still blurred
an ordinary music frame: safety 0.995695, porn 0.395200, hentai 0.025031,
sexy 0.021318. NSFWJS did not actually flag that frame, which is why the final
rule requires its preset threshold rather than a small sum of probabilities.

Safety-only spikes remain flagged for the two-of-three window. Before first
reveal, strong flagged frames still keep a video hidden. Only safety <= 0.7 with
NSFWJS porn+hentai+sexy <= 0.3 counts as clean for video: borderline safety alone
must not perpetually reset the three-clean-frame reveal streak. NSFWJS-supported
hits, stronger safety scores, the NSFWJS-only fallback, image thresholds, pause
exceptions and failure handling retain their existing rules. Corroborated
safety=0.99/porn=0.99 still blocks on its first sample.

## Safety score distribution

Before: median 5.63e-8; p90 0.253729; p95 0.692868; min 1.63e-24;
max 0.995961. Seven of 195 frames had safety >= 0.9. None of those seven had
NSFWJS neutral >= 0.9; their NSFWJS disagreement also included drawing scores.
After: median 2.14e-8; p90 0.250272; p95 0.605363; min 4.39e-23;
max 0.988727. Six of 192 frames had safety >= 0.9; again none had neutral >= 0.9.

| Safety score (lower inclusive, upper exclusive except 1) | Before | After |
| --- | ---: | ---: |
| [0, 0.3) | 175 | 173 |
| [0.3, 0.5) | 7 | 6 |
| [0.5, 0.7) | 3 | 4 |
| [0.7, 0.9) | 3 | 3 |
| [0.9, 0.97) | 3 | 1 |
| [0.97, 1] | 4 | 5 |

For the input investigation: gaming and a different music route returned the
identical vector safety 0.988504 / porn 0.010010 / hentai 0.026247 /
sexy 0.002063 / neutral 0.173372, including samples near playback time zero.
This may represent a shared transition frame; numeric scores alone cannot
establish the pixels or their preprocessing. No offscreen inference code was
changed; its only modification is two dev-only score override lines.

## Validation and reproduction

- `node --test test/video-policy.mjs`: 9/9 passing.
- `npm run typecheck`: passing.
- `node build.mjs --dev`: passing.
- `TZ_TEST_PORT=18477 node test/e2e.mjs`: 337 passed, 0 failed.
- `NO_GPU=1 TZ_TEST_PORT=18477 node test/e2e.mjs`: 337 passed, 0 failed.
- Production bundles were built in memory with `__DEV__=false`: no numeric frame
  trace marker or new test tags remain.

The dev override lines force safety-only 0.95 and 0.6 even on the CPU path. Browser
regressions verify a shown video stays clean on exactly one 0.95 frame, a first
explicit frame blocks immediately, and a new 0.6 safety-only preview reveals.
Numeric sampler tests also preserve two-of-three confirmation, paused-still
tolerance, the clean streak, threshold boundaries and the no-safety fallback.

Raw local artifacts (gitignored): `test/.artifacts/video-trace/before-combined.json`,
`after.json`, `matched-replay.json`, `after-sum-candidate.json`, `e2e-gpu.log`, `e2e-cpu.log`.
The baseline combines the original 11 successful YouTube routes and a separate
flower run made against a preserved copy of the original isolated build.

```sh
# Start with the dev trace hook added, before changing the policy:
node build.mjs --dev
node test/video-trace.mjs baseline
# Apply the policy fix, then replay exactly the successful baseline routes:
node build.mjs --dev
node test/video-trace.mjs after --limit=12 --replay=test/.artifacts/video-trace/baseline.json
# Recompute transition categories and distributions without opening a browser:
node test/video-trace.mjs --summarize=test/.artifacts/video-trace/baseline.json
node test/video-trace.mjs --summarize=test/.artifacts/video-trace/after.json
# Replay the same baseline predictions through the before/after watcher sources:
node test/video-trace-replay.mjs test/.artifacts/video-trace/baseline.json c5fc71b898e64f46b62a2b5aa376866d89339192 test/.artifacts/video-trace/matched-replay.json
```

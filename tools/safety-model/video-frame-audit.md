# Unpublished safety-v3 video-frame candidate

## Recommendation: DON'T SHIP

The strict release gate fails: the frozen held-out full balanced rule catches
**5,234 / 5,322**, versus the independently reproduced v2 **5,235 / 5,322**.
Drawn-style recall loses three items while photo recall gains two. Held-out
thumbnail FP also rises. The substantial ordinary-frame improvement is not a
reason to waive those regressions. No release was published and the v2 pin in
`extension/models/safety.json` is unchanged. There was one predeclared seed-0
candidate, not a search for a seed/threshold that passes this held-out set.

Candidate: `work/safety-v3.onnx`, 78,732,097 bytes, SHA-256
`511a46c9a0315ef594273a6e66995a6eb815c7a6acb60d9c567d99248f8891e0`.
The fp16 export's random-input maximum deviation from the fp32 Torch reference
was 0.00093353. Frozen-embedding evaluations below use the rounded, exported head
weights, not an unrounded in-memory training head.

## Ordinary frame corpus

183 ordinary public videos, 1,830 frames, 39 channels, eight genres. Training:
146 videos / 1,460 frames / 31 channels. Evaluation: **37 videos / 370 frames /
eight entire channels never used for training**, including the thumbnail corpus.
The held-out channels are Laufey, Colin and Samir, Adam Ragusea, NFL,
FitnessBlender, NBC News, Pokemon Japan and Minecraft. Splits were selected by
channel before fitting; no video/resize variant can cross sides.

| Genre | Videos | Frames |
| --- | ---: | ---: |
| Music | 18 | 180 |
| Vlogs | 25 | 250 |
| Cooking | 25 | 250 |
| Sports | 24 | 240 |
| Gaming | 25 | 250 |
| Beauty/fitness | 23 | 230 |
| News | 25 | 250 |
| Kids/animation | 18 | 180 |

The animation bucket includes five ordinary official TOHO/Frieren clips (PV,
preview, ending, mini-animation and orchestra recording), plus ordinary Pixar,
GKIDS and children's programming where available. Pokemon Japan is held out.
Only allowlisted ordinary channels were queried. Age-restricted and
explicit-sounding titles were rejected; inaccessible or oversized downloads were
skipped, without replacement based on model scores. These are metadata-screened
ordinary videos, not a claim of independent human adjudication of every frame.
Cross-channel reuse of footage remains possible even with disjoint publisher IDs.
As an additional numeric check, the maximum held-out-to-training frame embedding
cosine similarity is 0.906653; none of the 370 held-out frames has a training
neighbor at or above 0.99. This does not deduplicate the original 48K dataset.

`video-frames.csv` records every included URL, immutable video ID, channel ID,
split, title, duration, downloaded-file SHA-256, capture dimensions and first/last
sample times. Work files, ordinary media and frames are gitignored. A fresh channel
discovery may differ as public channels change; the CSV is the frozen manifest
for this run. Unavailable items and fetch errors remain in local `videos.json` and
download logs. All captured videos yielded all ten frames; there were no capture
errors.
`refetch` uses the frozen CSV and enforces its downloaded-video hashes instead of
discovering a moving set of recent uploads; a changed encoding is an explicit
failure, not silently substituted evaluation pixels.

Ten equally spaced midpoint samples span each complete downloaded low-resolution
MP4, rather than just its opening minute. Chromium seeks and decodes the video,
draws the same `min(1, 448 / max(width,height))` canvas as `grabFrame`, and encodes
JPEG at 0.85. It then uses `createImageBitmap`, an `OffscreenCanvas` with high
smoothing quality, and whole-image squash to 224 RGB/255, matching
`decodeBlob`/`cropToImageData`. The existing NSFWJS model scores that exact
224-pixel image numerically. RN50/openai embeds both the `embed.py`,
`TZ_SQUASH=1` bicubic path and the actual browser tensor path, as v2 did for
thumbnails. Evaluation uses the browser variant only.

No explicit image was displayed, opened for human viewing, saved, screenshotted,
or printed. Original explicit dataset images were not read: all head training and
recall evaluation use the existing numeric `xl.npz` and NSFWJS scores. Rebuilding
the existing Commons label filter decodes that pre-existing corpus in memory and
writes detections/keys/embeddings only, never image copies or contact sheets.

## Recipe and evaluation

The original seed-0 80/20 split is unchanged: 38,397 training and 9,600 held-out
items (5,322 NSFW / 4,278 SFW). The recipe is RN50 frozen embeddings, scale 10,
1024 -> 512 -> GELU -> dropout 0.2 -> 1, 40 epochs, batches of 512,
AdamW 0.002 / weight decay 0.0001, cosine schedule, balanced-class BCE.
Commons, 3,000 synthetic negatives, both thumbnail resize variants and both frame
resize variants receive weight 3; dataset rows receive weight 1. The v2
video-grouped thumbnail split is preserved (132 train / 33 held-out videos,
66 held-out thumbnails). Evaluation thresholds were not tuned.

Full balanced rule, exactly as the v2 review:
`safety > 0.5 || sexy > 0.85 || hentai > 0.5`. Porn is not an additional trigger.
Drawn-style is the same numeric proxy, `NSFWJS drawing + hentai > 0.5`, not an
independent visual annotation. The original held-out dataset retains the known
near-duplicate leakage reported in CLAUDE.md; these are comparable frozen-split
numbers, not a new deduplicated generalization claim.

| Frozen evaluation | Published v2 head | Exported v3 head |
| --- | ---: | ---: |
| NSFW caught / 5,322 | 5,235 (98.3653%) | 5,234 (98.3465%) |
| Drawn NSFW caught / 1,089 | 1,029 | 1,026 |
| Photo NSFW caught / 4,233 | 4,206 | 4,208 |
| SFW falsely blocked / 4,278 | 132 | 138 |
| Held-out frame FP / 370 | 32 (8.65%) | 1 (0.27%) |
| Held-out videos with any sampled-frame FP / 37 | 13 | 1 |
| Video-held-out thumbnail FP / 66 | 0 | 2 |
| Dataset safety probabilities in [0.4, 0.6] / 9,600 | 31 | 34 |
| Those ambiguous rows: NSFW / SFW | 16 / 15 | 18 / 16 |

Frame false positives are per sampled frame under the full image decision rule,
not the video temporal window. NSFWJS sexy/hentai adds no extra image-rule FP to
either frame count. The remaining v3 FP is a Pokemon Japan frame: safety 0.983516,
NSFWJS porn 0.785392 / hentai 0.048488 / sexy 0.034468. It would still trigger the
corroborated immediate video rule; the startup relaxation cannot clear it.
The video-count row means any of
ten sparse samples, not a claim that those videos would blur in real playback.

### Rebuilt Commons filter and paired recipes

The old NudeNet drop file was missing. It was rebuilt with the official 640m
weights, at 640 pixels, using the existing `labelfilter.py` criteria: drop safe
rows with any exposed-class score > 0.3, and flagged rows with no detection > 0.3.
This removes 113 of 2,155 existing corpus rows: 47 safe rows with an exposed-class
detection and 66 flagged rows with no detection. These are automatic detections,
not an assertion that every dropped row really contains nudity or lacks a person.
The retained evaluation corpus is 1,838 safe, 120 swimwear and 84 lingerie rows.
Synthetic negatives stay separate from this filtering.

For paired leave-category-out comparisons, both freshly fitted recipes use that
same rebuilt filter, original dataset split, thumbnail split, seed and optimizer.
Only frame hard negatives differ. Each category is scored by a head that never
saw that entire Commons category. The paired thumbnail test similarly leaves an
entire channel (all sizes and resize variants) out of both recipes, retaining
other thumbnail channels. These paired recipe controls are **not** the published
v2 head scored on training-overlapping Commons/thumbnail items.

| Leave-entire-category-out full balanced rule | Paired v2 recipe | Paired v3 recipe |
| --- | ---: | ---: |
| Safe Commons FP / 1,838 | 85 | 83 |
| Swimwear caught / 120 | 107 | 107 |
| Lingerie caught / 84 | 67 | 66 |
| Beach crowd FP / 205 | 7 | 6 |
| Faces FP / 153 | 11 | 10 |
| Skin-tone food FP / 238 | 0 | 0 |
| Gym/sport FP / 215 | 29 | 27 |
| Hands/feet FP / 202 | 20 | 19 |
| Home listings FP / 206 | 9 | 10 |
| Medical skin FP / 133 | 6 | 8 |
| Pink animals FP / 178 | 0 | 0 |
| Raw meat FP / 60 | 0 | 0 |
| Textures FP / 248 | 3 | 3 |

| Leave-entire-channel-out thumbnails, full balanced rule | Paired v2 recipe | Paired v3 recipe |
| --- | ---: | ---: |
| All channels FP / 329 | 6 | 4 |
| Computerphile FP / 30 | 4 | 2 |
| Kurzgesagt FP / 30 | 1 | 1 |
| Technology Connections FP / 30 | 1 | 1 |
| Other eight channels FP / 239 | 0 | 0 |

The leave-channel-out result is encouraging but does not erase the frozen
video-held-out thumbnail regression (0 -> 2 / 66). Rebuilding the Commons filter
also changes the recipe relative to the published v2 head: a freshly fitted
**no-frames, clean-Common v2 control** catches 5,242 / 5,322 (1,031 / 1,089 drawn,
4,211 / 4,233 photo) with 135 / 4,278 SFW FP, 35 ambiguous probabilities and
43 / 370 held-out frame FP. Thus the v3 frame recipe loses eight recalled items
against that paired clean control, not just one against the published head.
The paired controls isolate frame additions; the published-head comparison is
still the required release gate.

## Startup experiment

The **dev-only experiment** ignores a safety-only signal through 0.9 when
NSFWJS porn+hentai+sexy <= 0.15, only before first reveal. Independent NSFWJS
sexy/hentai flags still decide, as does the NSFWJS-only fallback. After first
reveal, the existing safety-noise exception and two-of-three window are unchanged.
A persistent `revealed` bit prevents a later confirmed block from accidentally
re-entering startup relaxation; changing sources/preset resets it. A 0.90001
safety-only frame still keeps a new video hidden. Production startup policy is
unchanged because exact-score replay did not justify promoting this experiment.
Safe-reveal CSS, the first
verdict requirement, strong corroborated first-frame blocking, and YouTube's
never-pause exception are unchanged.

On the supplied v2 trace's identical numeric samples, replaying the actual old
and candidate watcher sources produces **4/12 blurred videos and three mid-watch
transitions for both**. The requested startup threshold cannot fix the observed
0.9+ spikes, so do not promote it as a demonstrated cure for those four videos.
Fresh live traces must be distinguished from exact-score replay: playback timing,
ads and sampled frame positions can differ even on the same routes.

## Same-route live playback

Balanced sensitivity, safe reveal, both real models active (NSFWJS WebGL and
safety WebGPU), 60 seconds per
route. All variants completed the same nine YouTube watch routes, two Shorts
revisits and the ordinary local flower sample. These are 12 playback routes but
only ten underlying source videos, not 12 independent content items. No trace
pixels or screenshots were recorded. The v3 runs temporarily used the local ONNX;
the final dev build is restored to the pinned v2 model.

| Model + video policy | Frames | Blurred routes / 12 | Mid-watch transitions | Unshown-doubtful transitions | 2-of-3 transitions |
| --- | ---: | ---: | ---: | ---: | ---: |
| v2 + rule, supplied reference | 194 | 4 | 3 | 3 | 3 |
| v2 + rule, refreshed control | 185 | 4 | 0 | 4 | 0 |
| v2 + rule + startup experiment | 180 | 4 | 0 | 4 | 0 |
| v3 + rule | 178 | **0** | **0** | 0 | 0 |
| v3 + rule + startup experiment | 173 | **0** | **0** | 0 | 0 |

No variant has an obvious-single-frame transition. V3's maximum observed safety
is 0.204423 in both live runs; every sampled v3 frame is below 0.3. The reference
v2 maximum is 0.999635, with three safety >= 0.9 / neutral >= 0.9 disagreements;
the refreshed v2 control maximum is 0.999660 with two such disagreements.

The three reference mid-watch transitions were on the Costa Rica route
(`LXb3EKWsInQ`); those particular frames were not sampled in the refreshed v2
control. Do not attribute that 3 -> 0 difference solely to v3. The more robust
result is the independent channel-held-out 32 -> 1 / 370 frame improvement and
the 4 -> 0 / 12 refreshed-route improvement. Identical-score replay of v3's
178 frames also produces zero blurred routes with either watcher. There is no
measured incremental startup benefit on either model, hence its dev-only status.

### Validation

- Numeric watcher/window tests: **14 passed, 0 failed**, including production
  startup preservation, dev threshold boundaries, both paused and playing video,
  the NSFWJS-only fallback, source resets and post-reveal confirmation.
- `npm run typecheck`: passed.
- Local-v3 dev build and final pinned-v2 dev build: passed. Both are verified by
  SHA-256; neither changes `extension/models/safety.json`.
- `TZ_TEST_PORT=18077 NO_GPU=1 node test/e2e.mjs`: **350 passed, 0 failed**, once.
- `TZ_TEST_PORT=18077 node test/e2e.mjs` (GPU): **350 passed, 0 failed**, once.
- Both full suites used the local v3 dev build and the startup experiment,
  including `__tz_test_flag` and the new numeric-only safety=0.8 regression.
- Production bundles built in memory strip the numeric frame diagnostic and all
  three safety-only test tags. Production rejects the local-model override before
  touching `dist`. Production replay exactly preserves the supplied v2 decisions.
- Recovering the head from the exported ONNX reproduces all 9,600 held-out
  candidate probabilities with **maximum difference 0**.

Local numeric artifacts: `work/video-report.json`, `work/video-predictions.npz`,
`work/commons-filter.json`, `work/nudenet-corpus.json`, `work/commons-drop.txt`,
`work/v3-exported-probs.npz`, training/export/paired/control logs, and
`extension/test/.artifacts/video-trace/{baseline-v2,v2-rule,v2-rule-startup,v3-rule,v3-rule-startup}.json`.
The trace directory also holds exact-score replay JSONs and both full e2e logs.
All are gitignored. None contains explicit pixels.

## Reproduction

Use the existing CUDA Python environment with `open_clip`, Torch, numpy, ONNX,
ONNX Runtime, `yt-dlp`, and NudeNet. The collection scripts use ffmpeg-compatible
low-resolution public MP4 downloads and Chromium's actual capture path; they never
render a corpus review sheet. Install missing Python packages into that venv.

From the repository root (PowerShell):

```powershell
$base = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-b3ed400c/tools/safety-model/work'
$thumb = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-b08d315f/tools/safety-model/work'
$py = "$base/venv/Scripts/python.exe"
$work = 'tools/safety-model/work'
Push-Location extension
npm ci
node build.mjs --dev
Pop-Location
& $py tools/safety-model/video-frames.py refetch "$work/video-frames"
node extension/test/video-frames.mjs "$work/video-frames"
$env:TZ_SQUASH = '1'
& $py tools/safety-model/video-frames.py embed "$work/video-frames"
Remove-Item Env:TZ_SQUASH
& $py tools/safety-model/video-frames.py manifest "$work/video-frames"
gh release download v3.4-weights --repo notAI-tech/NudeNet --pattern 640m.onnx --dir $work --clobber
& $py tools/safety-model/rebuild-corpus.py $base 'E:/GithubProjects/Toolize/extension/test/corpus' $work
& $py tools/safety-model/retrain-video.py $base $thumb $work
& $py tools/safety-model/retrain-video.py $base $thumb $work --paired
& $py tools/safety-model/retrain-video.py $base $thumb $work --control
& $py tools/safety-model/export.py RN50 openai "$work/head-v3.json" "$work/safety-v3.onnx" --fp16
Push-Location extension
$env:SAFETY_MODEL_PATH = (Resolve-Path '../tools/safety-model/work/safety-v3.onnx').Path
node build.mjs --dev
Remove-Item Env:SAFETY_MODEL_PATH
node --test test/video-policy.mjs
npm run typecheck
$trace = 'test/.artifacts/video-trace'
$env:TZ_TRACE_PORT = '18489'
node test/video-trace.mjs v3-rule --watcher-ref=integrate/round-4 --limit=12 --replay="$trace/baseline-v2.json"
$env:TZ_TRACE_PORT = '18499'
node test/video-trace.mjs v3-rule-startup --limit=12 --replay="$trace/baseline-v2.json"
node test/video-trace-replay.mjs "$trace/baseline-v2.json" integrate/round-4 "$trace/v2-startup-replay.json" --startup
Remove-Item Env:TZ_TRACE_PORT
$env:TZ_TEST_PORT = '18077'
node test/e2e.mjs
$env:NO_GPU = '1'
node test/e2e.mjs
Remove-Item Env:NO_GPU
node build.mjs --dev
Pop-Location
```

`SAFETY_MODEL_PATH` is rejected in a production build before deleting or writing
`dist`; an invalid local override fails instead of silently selecting the pin.
It never writes the release cache or model pin. An ordinary dev build without the
override still uses the pinned v2 model. `--watch` is a dev build too.

# YouTube thumbnail false positives

Measured 2026-11-08 (America/Chicago), on an RTX 5070 Ti / Chromium, using the
shipped `safety-v1` SHA-256 `b2e56ebf48e4902864af2532b5cfe06bc6117a665f27d373fc49b6578c66b3fa`.

## Finding

**The main failure is a safety-head generalization gap on ordinary thumbnails.**
It reproduces with the original OpenCLIP training transform/framework, Python CPU
ONNX Runtime, browser WASM, and the production WebGPU pipeline. Correct RGB layout
and normalization do not make these thumbnails clean. There are substantial resize
and fp16 sensitivities too; it would be inaccurate to claim all paths agree within
0.02. Neither is a batch/decoder race, and eliminating fp16 does not eliminate the
false positives.

An unpublished hard-negative candidate fixes the measured thumbnail failures while
preserving aggregate held-out NSFW recall. No production classifier, image loader,
pipeline, policy threshold, or model pin changed. The candidate must be reviewed
before any separate publishing task.

## Corpus and paths

329 safe public JPEG thumbnails from 165 videos / 11 educational, science,
mathematics and technology channels: 164 `hq720` and 165 `hqdefault`. Three feeds
in the fetcher's wider list returned 404 during the final collection; none were counted.
The collected sizes are 1280×720 and 480×360. The user's five original URLs were not
available, so this reproduces the failure class, not those exact 720×404 responses.
No explicit images or original training archives were opened. Original-data
evaluation below reads **embeddings only**.

[youtube-thumbnails.csv](youtube-thumbnails.csv) contains every public URL, title,
dimension, held-out membership, score, batch result, per-image backend/resize
difference, letterbox ablation and NSFWJS score. The exact source list can be
downloaded again with `refetch`; RSS feeds themselves change over time.
[youtube-summary.json](youtube-summary.json) holds the machine-readable totals.

The browser audit imports the real `SafetyClassifier`, `fetchImageBlob`,
`decodeBlob` and `cropToImageData` into an isolated extension origin. It writes the
actual RGB/255 NCHW float32 tensors to the gitignored artifact directory. Python
runs those exact tensors as well as Pillow/torchvision training preprocessing
(`draft('RGB', (448,448))`, `TZ_SQUASH=1`, bicubic resize). The ordinary corpus
runner separately exercises `ClassifyPipeline`, its concurrent Batcher, NSFWJS,
and final policy. All corpus-page inputs in this worktree were safe thumbnails.
WASM is forced only in the audit harness, with `--disable-gpu`; production stays
WebGPU-only for the safety model.

## False positives at safety > 0.5

| Path | v1 all 329 | v1 held-out 66 | v2 all 329 | v2 held-out 66 |
|---|---:|---:|---:|---:|
| Original PyTorch tower + shipped head, training resize | 17 (5.17%) | 7 (10.61%) | 0 | 0 |
| Python ORT CPU, training resize | 18 (5.47%) | 7 (10.61%) | 0 | 0 |
| Python ORT CPU, exact browser pixels | 18 (5.47%) | 7 (10.61%) | 0 | 0 |
| Real extension WebGPU, exact browser pixels | 21 (6.38%) | 8 (12.12%) | 0 | 0 |
| Browser ORT WASM, exact browser pixels | 18 (5.47%) | 7 (10.61%) | not rerun | not rerun |
| Diagnostic float32 tower, CPU / WebGPU | 19 / 19 (5.78%) | 7 / 7 (10.61%) | not applicable | not applicable |

**Full extension balanced verdict:** 21/329 (6.38%) → **1/329 (0.30%)**.
The remaining FP is `kurzgesagt--KBfIo9sZbC4--hqdefault.jpg` ("How Does Ketamine
Work?"): NSFWJS hentai 0.7018, v2 safety 0.000239. It is blocked by the existing
hentai-beside-safety rule. No NSFWJS veto or threshold weakening was added.
V2 still has a maximum CPU–WebGPU score difference of 0.06876 on this corpus;
all of its scores stay below 0.5. Its successful threshold result is not a claim
that fp16 inference now matches CPU within 0.02.

## Hypothesis checks

1. **Layout and normalization:** `runBucket` fills independent R, G, B planes with
   channels divided by 255. The shipped graph starts `Cast → Sub(mean) → Div(std)`.
   Its half-precision constants are mean `[.4814453,.4577637,.4082031]`, std
   `[.2685547,.2612305,.2758789]`, consistent with CLIP's rounded constants. It
   expects `[batch,3,224,224]`; there is no missing or double normalization. A
   manifest-only replay of `embed.py` generated bit-identical training embeddings.
2. **Alpha / color / formats:** 12 safe probes (four actual thumbnails re-encoded
   as JPEG, WebP and AVIF) were decoded with default options and with
   `premultiplyAlpha:'none', colorSpaceConversion:'none'`. Every resulting channel
   matched byte-for-byte, alpha was 255 throughout, and ImageData was sRGB.
   Pillow+CPU scoring of the same probes also reproduced high probabilities. These
   are controlled opaque sRGB probes, not a claim about every possible ICC profile
   or the unavailable original CDN query responses.
3. **Padding / batch dependence:** all 329 WebGPU inputs were scored alone, with
   seven zero images, and alongside seven other thumbnails. Maximum change was
   **1.1921e-7** for either comparison. CPU's near-threshold probe was exactly
   **0.4875729084** alone / zeros / other images. WASM also retained 18 FPs across
   single/mixed batches. The exported graph has no Dropout or BatchNormalization
   nodes; normalization layers were folded into convolutions.
4. **fp16 / WebGPU:** all observed outputs were finite. Maximum WebGPU–CPU
   difference was **0.24809**; WASM–CPU was **0.0018765**. Re-exporting the same
   head with a float32 tower reduced WebGPU–CPU error to **0.00002736**, but still
   blocked 19 thumbnails, including ordinary object thumbnails near 1.0. Thus
   precision affects calibration and some boundary decisions; catastrophic
   fp16 overflow is not needed to reproduce the main issue. Float32 doubles model
   size (155,312,563 vs 78,732,097 bytes), so it was kept as a diagnostic artifact.
5. **Reuse / races:** crops allocate a fresh OffscreenCanvas and `getImageData`
   buffer; Batcher queues those objects, splices each item once, preserves order
   through Promise.all, and drains inference serially. The concurrent real
   pipeline reproduced the direct classifier's 21 FPs. No shared pixel buffer or
   evidence of a cross-job pixel swap was found.
6. **Bars / resizing:** conservatively trimming near-black border rows/columns
   before CPU inference reduced FPs **18 → 13**. Bars contribute but cannot explain
   all failures. Canvas versus training bicubic preprocessing changed one score
   by **0.90403** (Heating A Ball: training 0.00520, browser pixels 0.90923).
   Training on both resize paths addresses this sensitivity without cropping out
   potentially unsafe edges in production. No general bar-stripping change was
   shipped without measuring its NSFW recall.

## What kinds of thumbnails fail?

Safe examples were inspected; no explicit imagery was inspected. The failures
include a cropped man's nose/cheek beside a computer with large green/white text
(Computerphile), an orange/brown ceiling fan with large white text (Technology
Connections), a fully clothed man against red/blue flags and large text
(Smarter Every Day), and sparse colored equations on a nearly black background
(3Blue1Brown). They are **not confined to faces, skin colors or letterboxes**.

| Ordinary thumbnail | Training PyTorch | CPU, browser pixels | WebGPU | NSFWJS neutral |
|---|---:|---:|---:|---:|
| Recreating ITS / Computerphile | 0.9999995 | 0.9999974 | 0.9999987 | 0.9669 |
| Ceiling fans / Technology Connections | 0.9999979 | 0.9999995 | 0.9999998 | 0.3956 |
| The PROBLEM with Capitalism / Smarter Every Day | 0.99127 | 0.98122 | 0.98800 | 0.9880 |
| The Phone Number puzzle / 3Blue1Brown | 0.22286 | 0.86945 | 0.86687 | 0.5473 |

The first two are decisive counterexamples to an extension-only input corruption
explanation. The last demonstrates a real training/inference resampling gap.
Model attribution to a specific visual feature would require controlled feature
ablations; these examples alone do not establish one feature as causal.

## Candidate training and recall

`retrain-youtube.py` uses the existing frozen `xl.npz` and `corpus-train.npz`,
the same 512-unit MLP / 40 epochs / class balance / AdamW schedule / 3× hard-negative
weight. It adds thumbnail embeddings from **both** training and browser resize
paths. The original seed-0 80/20 dataset split is preserved. Per channel, three
videos are held out using seed 20261108: **132 training videos / 33 held-out videos**.
Both thumbnail sizes and both resize paths of a video always stay on one side.
There is no cross-variant leakage. This is video-held-out, not channel-held-out.

| Original held-out embedding evaluation | Shipped v1 head | Exported v2 head |
|---|---:|---:|
| NSFW caught / 5,322 | 5,223 (98.1398%) | 5,223 (98.1398%) |
| SFW falsely blocked / 4,278 | 100 (2.3375%) | 93 (2.1739%) |

Aggregate recall does not drop; **10 former misses are recovered and 10 previously
caught items become misses**. Both heads use the identical held-out split. The
v2 counts were verified again using weights recovered from the exported ONNX.
This is a frozen-embedding head comparison, not an end-to-end replay of explicit
images. No original explicit image was opened for this task. All-set YouTube
numbers include training items; use the separate 66-image held-out column to
judge generalization. A broader channel-held-out test remains useful before
publishing.

The candidate preparation/training took **14.6 seconds**, with export taking
seconds more. It is at `work/safety-v2.onnx` (78,732,097 bytes), SHA-256:
`02ec0cb54caac6dd0ec1c1c40d06be9ef845e5021547965e7b25b67f450c8c25`.
The file and training artifacts are gitignored. `extension/models/safety.json`
and the published release are unchanged. Additional synthetic letterbox/text
negatives and channel-held-out thumbnails are reasonable next coverage work;
adding the measured thumbnail hard negatives already fixes this test.

## Reproduce (PowerShell, repository root)

Use the existing Python environment with torch, open_clip, Pillow, numpy, onnx and
onnxruntime. Keep the corpus page's input directory safe-only; it can render
misclassification thumbnails. The dedicated audit never displays image elements.

```powershell
$baseWork = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-b3ed400c/tools/safety-model/work'
$py = "$baseWork/venv/Scripts/python.exe"
$work = 'tools/safety-model/work'
$thumbs = 'extension/test/corpus/safe/youtube-thumbs'
New-Item -ItemType Directory -Force $work | Out-Null
& $py tools/safety-model/youtube-thumbs.py refetch tools/safety-model/youtube-thumbnails.csv $thumbs

Push-Location extension
npm ci
npm run typecheck
node build.mjs --dev
node test/corpus-run.mjs
node test/safety-audit.mjs
node test/safety-audit.mjs test/.artifacts/safety-audit wasm
Pop-Location

$v1 = 'extension/.cache/safety-b2e56ebf48e49028.onnx'
$audit = 'extension/test/.artifacts/safety-audit'
& $py tools/safety-model/youtube-thumbs.py cpu $v1 $thumbs $audit
& $py tools/safety-model/youtube-thumbs.py letterbox $v1 $thumbs $audit
& $py tools/safety-model/youtube-thumbs.py embed $thumbs "$work/youtube.npz"
& $py tools/safety-model/head-probs.py $v1 "$work/youtube.npz" "$work/youtube-v1.npz"
& $py tools/safety-model/retrain-youtube.py $baseWork $work $audit
& $py tools/safety-model/export.py RN50 openai "$work/head-v2.json" "$work/safety-v2.onnx" --fp16

Push-Location extension
$env:SAFETY_MODEL = (Resolve-Path '../tools/safety-model/work/safety-v2.onnx').Path
node test/corpus-run.mjs
node test/safety-audit.mjs test/.artifacts/safety-v2 webgpu
Remove-Item Env:SAFETY_MODEL
Pop-Location
```

`SAFETY_MODEL` replaces the model only inside the test harness's temporary isolated
extension. `SAFETY_CORPUS` can select the safe codec-probe directory. The `codecs`
subcommand produces those 12 probes; run the audit and CPU scorer on that directory.
For the float32 diagnostic, omit `--fp16` during export and select that model with
`SAFETY_MODEL` in the same way. `report-youtube.py` joins all audits plus explicitly
named v1/v2 corpus JSON files into the CSV and summary above.

The bucket-forcing audit disables idle background warm-up: calling private
`runBucket` bypasses `classifyBatch`'s `lastUse` bookkeeping. An initial forced
run overlapped warm-up and threw ORT `Session mismatch`; isolating the diagnostic
runs avoids that confound. The normal corpus runs retain production scheduling.
This is not evidence of pixel reuse or an explanation for high scores; production
idle-warm-up serialization remains a separate reliability consideration.

## Required checks

- `npm run typecheck`: passed.
- `node build.mjs --dev`: passed, shipped model pin retained.
- Full `TZ_TEST_PORT=18577 node test/e2e.mjs`: **334 passed, 0 failed**, run once.
- New audit checks reject non-finite or batch-dependent probabilities. No e2e
  production-pipeline fix regression was needed because no such bug was found.
- Protected companion, content video and popup files were not edited.

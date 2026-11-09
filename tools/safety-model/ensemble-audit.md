# Unpublished safety-v3 five-seed ensemble

Run date: 2026-11-08. Base: `feat/safety-v3-video-frames`, `5809e53`.

## Recommendation: pending runtime validation

The requested **offline gate passes**, without choosing a seed or adjusting a
threshold on the held-out data. Runtime validation and the remaining descriptive
leave-category/channel-out results are recorded below when complete. No release
is published and `extension/models/safety.json` remains pinned to v2.

## Experiment fixed before evaluation

- Five seeds, **0, 1, 2, 3, 4**, for both recipes, independent of the unchanged
  seed-0 dataset split: 38,397 training / 9,600 held-out rows.
- RN50 frozen 1,024-dimensional embeddings, scale 10; 512-unit GELU MLP,
  dropout 0.2; 40 epochs, batch 512, AdamW learning rate 0.002, weight decay
  0.0001, cosine schedule, the existing balanced-class BCE and hard-negative
  weight 3. Exported head weights retain the existing six-decimal rounding.
- Both paired recipes use the same rebuilt Commons filter (1,838 safe,
  120 swimwear, 84 lingerie) plus 3,000 synthetic negatives and both thumbnail
  resize variants. Only v3 adds the 1,460 training frames, both resize variants,
  at weight 3. Thus this is the previous audit's **clean-Common paired v2
  recipe**, not an attempt to reconstruct the lost historical filter.
- Both retain the frozen thumbnail split: 132 training / 33 held-out videos,
  66 held-out thumbnails. The independent ordinary-frame evaluation is 370
  browser-path frames / 37 videos / eight completely held-out channels. Those
  channels are also absent from thumbnail training. Category/channel refits use
  the same five seeds, with the entire evaluation category/channel excluded.
- Every decision uses the unchanged full balanced rule:
  `safety > 0.5 || sexy > 0.85 || hentai > 0.5`; porn is not an extra trigger.
  Drawn is the existing numeric proxy `drawing + hentai > 0.5`, not a new visual
  annotation. Calibration counts include both endpoints of `[0.4, 0.6]`.
- We average the **five probabilities**, not logits. This is a bounded equal
  vote in probability space: one highly saturated head cannot dominate through
  arbitrarily large log odds. It is not a claim of calibrated probabilities.
  The aggregation and 0.5 threshold were fixed before any result was examined.

All original explicit-data evaluation reads **embeddings and existing numeric
scores only**. No explicit image was opened, displayed, decoded, copied, saved,
screenshotted, or printed; the original image archive was not read. Ordinary
public playback and the e2e suite's synthetic color fixtures are separate from
that dataset. No new media collection or Commons image processing was needed.
The prior `t3-aebc37fa` work directory is referenced in place; its numeric files
are not modified. Input hashes are frozen in `work/ensemble-experiment.json`.

## Full frozen held-out dataset

The shipped-v2 weights are recovered from the ONNX with the exact pinned SHA-256,
not replaced by a freshly fitted head. Its 5,235 / 5,322 baseline reproduces.

| Full balanced rule | Shipped v2 | v2 ensemble | v3 ensemble |
| --- | ---: | ---: | ---: |
| NSFW caught / 5,322 | 5,235 | 5,234 | **5,238** |
| Drawn NSFW caught / 1,089 | 1,029 | 1,026 | **1,027** |
| Photo NSFW caught / 4,233 | 4,206 | 4,208 | **4,211** |
| SFW FP / 4,278 | 132 | 138 | 135 |
| Drawn SFW FP / 1,084 | 94 | 97 | 92 |
| Photo SFW FP / 3,194 | 38 | 41 | 43 |
| Safety in [0.4, 0.6] / 9,600 | 31 | 30 | 31 |
| Ambiguous NSFW / SFW | 16 / 15 | 18 / 12 | 19 / 12 |

The ensemble meets the permitted drawn floor exactly: **two fewer**, not more
than two fewer, than shipped v2. It gains five photo catches. A single-seed
point estimate would obscure this domain tradeoff.

## Deduplicated held-out dataset

Drop every held-out row whose normalized float32 embedding cosine is **strictly
greater than 0.995** to *any* training row. The common reference is the union of
the two recipes' dataset, clean Commons, synthetic, thumbnail and frame training
embeddings, including both resize paths. All three models use the same mask.
This removes **4,055** rows, all already matched to original-dataset training
rows; additional hard negatives remove none. The retained set is **5,545 rows**:
3,263 NSFW and 2,282 SFW. This explicitly recomputed denominator replaces, rather
than silently reusing, the historical README's 4,056 near-duplicate count.

| Deduplicated full balanced rule | Shipped v2 | v2 ensemble | v3 ensemble |
| --- | ---: | ---: | ---: |
| NSFW caught / 3,263 | 3,177 | 3,176 | **3,180** |
| Drawn NSFW caught / 1,059 | 1,000 | 997 | **998** |
| Photo NSFW caught / 2,204 | 2,177 | 2,179 | **2,182** |
| SFW FP / 2,282 | 128 | 134 | 131 |
| Drawn SFW FP / 1,028 | 93 | 96 | 91 |
| Photo SFW FP / 1,254 | 35 | 38 | 40 |
| Safety in [0.4, 0.6] / 5,545 | 31 | 30 | 31 |
| Ambiguous NSFW / SFW | 16 / 15 | 18 / 12 | 19 / 12 |

## Paired seed variation

All entries use exported, rounded head weights. No seed was dropped or selected.

| Seed | v2 NSFW | v3 NSFW | v3 minus v2 | v2 drawn | v3 drawn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 5,242 | 5,234 | -8 | 1,031 | 1,026 |
| 1 | 5,234 | 5,237 | +3 | 1,028 | 1,029 |
| 2 | 5,236 | 5,238 | +2 | 1,027 | 1,027 |
| 3 | 5,235 | 5,234 | -1 | 1,027 | 1,027 |
| 4 | 5,232 | 5,235 | +3 | 1,024 | 1,027 |
| Probability ensemble | 5,234 | 5,238 | +4 | 1,026 | 1,027 |

The paired per-seed total-recall differences have mean **-0.2 items** and sample
standard deviation **4.66 items**. This supports the reviewer's seed-noise warning;
it is not evidence that each retraining improves recall or a five-seed confidence
interval for a future ensemble. The no-frame v2 ensemble itself is one catch below
shipped v2. Seed 0 reproduces the previous v3 and clean-v2-control counts exactly.

## Commons leave-entire-category-out

All 12 category refits are complete, five seeds per recipe per excluded category.
Shipped-v2 scores overlap its training data and **are not leave-category-out**;
they are reported only to satisfy the three-model replay, not as generalization
baselines. Swimwear/lingerie gates use the honestly category-excluded paired v2
ensemble, not shipped v2's 120/120 and 84/84 resubstitution scores.

| Full balanced rule | n | Shipped v2, training overlap | v2 ensemble, LCO | v3 ensemble, LCO |
| --- | ---: | ---: | ---: | ---: |
| Safe Commons FP | 1,838 | 27 | 82 | 84 |
| Swimwear caught | 120 | 120 | 107 | 107 |
| Lingerie caught | 84 | 84 | 67 | 66 |
| Beach crowd FP | 205 | 4 | 6 | 6 |
| Faces FP | 153 | 1 | 10 | 11 |
| Skin-tone food FP | 238 | 0 | 0 | 0 |
| Gym/sport FP | 215 | 6 | 30 | 27 |
| Hands/feet FP | 202 | 11 | 18 | 21 |
| Home listings FP | 206 | 2 | 8 | 9 |
| Medical skin FP | 133 | 2 | 7 | 8 |
| Pink animals FP | 178 | 0 | 0 | 0 |
| Raw meat FP | 60 | 0 | 1 | 0 |
| Textures FP | 248 | 1 | 2 | 2 |

## Ordinary frames and thumbnails

| Full balanced rule | Shipped v2 | v2 ensemble | v3 ensemble |
| --- | ---: | ---: | ---: |
| Ordinary held-out frame FP / 370 | 32 | 40 | **1** |
| Videos with any sampled-frame FP / 37 | 13 | 15 | 1 |
| Frozen v2 video-held-out thumbnail FP / 66 | 0 | 1 | **2** |

The **0 to 2 / 66 thumbnail regression remains**; the requested gate does not
include thumbnail non-regression, and it must not be hidden by the frame result.
Per-frame FP is not the temporal video verdict.

All 11 leave-entire-channel-out refits are complete. A refit excludes every size
and both resize variants for that channel, retaining all other thumbnail channels,
exactly as in the previous audit. The shipped head has thumbnail training overlap
on this 329-item table; its genuinely frozen held-out result is the 66-item row.

| Channel-held-out thumbnail FP | n | Shipped v2, training overlap | v2 ensemble | v3 ensemble |
| --- | ---: | ---: | ---: | ---: |
| All channels | 329 | 1 | 5 | 3 |
| Computerphile | 30 | 0 | 3 | 1 |
| Kurzgesagt | 30 | 1 | 1 | 1 |
| Technology Connections | 30 | 0 | 1 | 1 |
| Other eight channels | 239 | 0 | 0 | 0 |

Other channels are 3Blue1Brown, MKBHD, NASA, Numberphile, Practical Engineering,
Smarter Every Day, Stand-up Maths, and Veritasium. Full per-channel and per-seed
scores are retained in the numeric artifacts. Channel-held-out improvement does
not erase the frozen 66-thumbnail regression.

## Gate

| Required offline gate | Shipped / paired baseline | v3 ensemble | Result |
| --- | ---: | ---: | --- |
| Full NSFW recall no lower | 5,235 | 5,238 | PASS |
| Deduplicated NSFW recall no lower | 3,177 | 3,180 | PASS |
| Full drawn no more than two lower | 1,029 (floor 1,027) | 1,027 | PASS, at floor |
| Deduplicated drawn no more than two lower | 1,000 (floor 998) | 998 | PASS, at floor |
| Category-held-out swimwear no more than two lower | 107 (floor 105) | 107 | PASS |
| Category-held-out lingerie no more than two lower | 67 (floor 65) | 66 | PASS |
| Ordinary-frame FP clearly better | 32 / 370 | 1 / 370 | PASS |

For a concrete interpretation of "clearly better", the numeric gate predeclared
at least a halving of frame FP; the measured reduction is **96.875%**. This is a
small metadata-screened ordinary corpus, not an independently adjudicated sample
of all online video. Residual cross-channel footage reuse is still possible.

## Export and runtime validation

`work/safety-v3e.onnx`, **87,137,810 bytes** (87.14 MB / 83.10 MiB), SHA-256:
`14d5a6bb92bee51e8724e0273117b12774c39de29268a8d8d3f21bf18d798e5c`.
The paired v2 ensemble has the same size, SHA-256:
`2b243a9b3a5dc44deb2f97b554cca203dd0f34826221ec2bbea03c121655decc`.

Both are **one self-contained ONNX**, preserving float32 `pixels [B,3,224,224]`
to float32 `probs [B,1]`, dynamic batch, opset 17. The shipped fp16 tower is
copied once, unchanged; five fp32 heads and their probability mean live inside
the graph. There are 121 tower initializers, not five copies of the tower.
The heads are packed for execution, not retrained or compressed: concatenate the
five first-layer matrices into one 1,024-to-2,560 projection, apply the identical
elementwise GELU, reshape into five independent 512-unit blocks, apply each
head's own output weights, sigmoid each logit, then mean the five probabilities.
The original separate-branch graph cost about **2.9x v2 at batch 1**, despite a
single tower. Packing removes that kernel-launch overhead without changing any
held-out threshold decisions, weights, seeds, or aggregation.

The extra four 512-unit fp32 heads necessarily add about 8.4 MB: **10.7% over
78,732,097-byte v2**, not an exact 79 MB total. Keeping all five full heads fp32
and their existing width cannot retain the single-head byte count.

- ONNX full checker: passed for both complete models and isolated exported heads.
- Recovered exported-head ONNX vs Torch, all 9,600 held-out embeddings: max
  absolute difference **5.36e-7 v2**, **2.98e-7 v3**; all 9,600 threshold decisions
  match, with no image decoding. The complete numeric evaluation was replayed
  from the cached heads after packing; no seed was retrained or replaced.
- CPU ONNX synthetic numeric tensors: batches **1, 2, 8** return finite float32
  probabilities of the exact expected shape for both ensembles.
- Numeric-only ensemble/export/split regression tests: **6 passed**.
- Numeric video-policy tests: **14 passed**. TypeScript typecheck: passed.
- Local-candidate dev build: passed, override hash verified.
- `TZ_TEST_PORT=18077 NO_GPU=1 node test/e2e.mjs`: **350 passed, 0 failed**.
- GPU e2e and serial real-playback trace of the final packed artifact: pending.

### Actual WebGPU path

RTX 5070 Ti, Windows, Playwright Chromium 1223, onnxruntime-web **1.22.0**.
`onnx-bench.mjs` now uses the extension's flags/runtime settings: WebGPU,
single-threaded WASM support, no forced Vulkan, graph optimization `all`.
All four production batch buckets validate finite float32 `[B,1]` outputs and
dispose tensors like the classifier. Models rotate order over three rounds,
25 timed repetitions per warmed shape, with no concurrent training/browser suite.
The table is median milliseconds per **batch**, excluding model load and shader
compilation, not a whole-page latency or a new hardware-independent guarantee.

| WebGPU batch | Shipped v2 ms | v2 ensemble ms | v3 ensemble ms | v3 / shipped v2 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 8.776 | 8.644 | 8.512 | 0.970x |
| 2 | 10.196 | 10.736 | 10.488 | 1.029x |
| 4 | 12.792 | 13.212 | 13.120 | 1.026x |
| 8 | 21.764 | 22.184 | 21.520 | 0.989x |

**PASS: all batch sizes are below the requested approximately 2x ceiling.**
The small sub-baseline differences are timing noise, not a claim that five heads
are intrinsically faster. Batch 8 is approximately 2.69 ms/image for v3. Raw rounds
and the discarded naive graph's measurements remain in the work directory.

Initial trace attempts, including one overlapping another browser suite, began
while shader warm-up was still active and produced insufficient safety-scored
diagnostics. They are excluded, not counted as zero-FP traces. A diagnostic copy
of the pipeline with its safety-error fallback removed successfully returned real
safety scores for three synthetic inputs after warming. The harness now waits for
shader warm-up, explicitly activates each playback page, records visibility,
retains numeric failed-route diagnostics, and rejects any route without at least
three finite safety-scored frames. Browser tests and the latency benchmark run
serially, after numeric training finishes. No product policy or threshold changes
are used to qualify the candidate.

## Reproduction

From the repository root in PowerShell, using the existing CUDA environment and
frozen numeric artifacts:

```powershell
$base = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-b3ed400c/tools/safety-model/work'
$thumb = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-b08d315f/tools/safety-model/work'
$video = 'C:/Users/boss_/.t3/worktrees/Toolize/t3-aebc37fa/tools/safety-model/work'
$py = "$base/venv/Scripts/python.exe"
$work = 'tools/safety-model/work'
& $py tools/safety-model/test-ensemble.py
& $py -u tools/safety-model/retrain-ensemble.py $base $thumb $video $work
Push-Location extension
npm ci
$env:SAFETY_MODEL_PATH = (Resolve-Path '../tools/safety-model/work/safety-v3e.onnx').Path
node build.mjs --dev
Remove-Item Env:SAFETY_MODEL_PATH
node --test test/video-policy.mjs
npm run typecheck
$env:TZ_TEST_PORT = '18077'
$env:NO_GPU = '1'
node test/e2e.mjs
Remove-Item Env:NO_GPU
node test/e2e.mjs
$trace = 'test/.artifacts/video-trace'
New-Item -ItemType Directory -Path $trace -Force | Out-Null
Copy-Item "$video/../../../extension/test/.artifacts/video-trace/baseline-v2.json" "$trace/baseline-v2.json"
$env:TZ_TRACE_PORT = '18529'
node test/video-trace.mjs v3e-rule --watcher-ref=integrate/round-4 --limit=12 --replay="$trace/baseline-v2.json"
Remove-Item Env:TZ_TRACE_PORT
node test/onnx-bench.mjs "$thumb/safety-v2.onnx" 224 --compare=../tools/safety-model/work/safety-v2e.onnx --compare=../tools/safety-model/work/safety-v3e.onnx --runs=25 --rounds=3 --webgpu-only
node build.mjs --dev
Pop-Location
```

Training resumes cached seed groups only when the frozen input hashes and declared
experiment match. Use a fresh output directory for a different recipe. Numeric
artifacts include `ensemble-report.json`, `ensemble-predictions.npz`, the nearest
training cosines and common deduplication mask, per-seed head weights for every
category/channel refit, both exported models/isolated head graphs, and test logs.
All work artifacts remain gitignored. The model pin and published release are
untouched.

# Independent review: five-seed safety-v3 ensemble (`safety-v3e.onnx`)

Reviewer: Claude (independent of the builder), 2026-11-08. Scope: check the
claims in `ensemble-audit.md` and finish the runtime checks that were still
outstanding. This review used embeddings, labels, keys and numeric scores only.
No dataset image was opened, decoded, displayed or written. The ONNX-on-pixels
check used the ordinary YouTube frames' stored browser-path float tensors
(`video-frames/*.f32`), and none of them was viewed.

## Verdict: SHIP WITH CAVEATS

Every offline number in the audit reproduces exactly from my own code. The ONNX
does what the audit says it does. Runtime is clean: the 12-route trace has
0/12 routes blurred (v2: 4/12), and GPU and NO_GPU e2e both pass 350/0. The recall
"pass", though, is a tie within seed noise, not an improvement (see caveats).
What the candidate actually wins is ordinary-video false positives.

## Reproduced numbers (independent numpy re-implementation)

My script did not import the candidate's code. It rebuilds the seed-0 split,
the drawn proxy, the full rule, the union-reference dedup and the per-head MLP
forward pass (exact erf GELU) from the cached `ensemble-heads/main/*.npz` and
the shipped ONNX's head initializers.

| Metric | Claimed (v2 / v2e / v3e) | Reproduced |
| --- | --- | --- |
| Full NSFW caught / 5,322 | 5,235 / 5,234 / 5,238 | identical |
| Full drawn / 1,089 | 1,029 / 1,026 / 1,027 | identical |
| Full photo / 4,233 | 4,206 / 4,208 / 4,211 | identical |
| Full SFW FP / 4,278 | 132 / 138 / 135 | identical (drawn 94/97/92, photo 38/41/43) |
| Dedup dropped / retained / NSFW | 4,055 / 5,545 / 3,263 | identical; all 4,055 match original-train rows |
| Dedup NSFW caught / 3,263 | 3,177 / 3,176 / 3,180 | identical |
| Dedup drawn / 1,059 | 1,000 / 997 / 998 | identical |
| Dedup SFW FP / 2,282 | 128 / 134 / 131 | identical |
| Per-seed v3 full NSFW | 5,234 / 5,237 / 5,238 / 5,234 / 5,235 | identical |
| Held-out frame FP / 370 (cached emb) | 32 / 40 / 1 | identical |
| Frozen 66 thumbnails FP | 0 / 1 / 2 | identical |
| LCO swimwear / 120 (v2e / v3e) | 107 / 107 | identical |
| LCO lingerie / 84 (v2e / v3e) | 67 / 66 | identical |
| Frame FP via **ONNX on pixels**, CPU ORT | — | v3e **1**/370 (1/37 videos); shipped v2 31/370 (12/37) |

## Leakage and honesty

- **Dataset:** heads train on `features[train]` only, from the fixed
  `default_rng(0)` permutation. The train and test indices are disjoint
  (asserted). The training seeds 0–4 are fixed in code, and no seed was dropped.
- **Frames:** only `split == 'train'` frames are used, with both resize variants.
  The script asserts that train and test channels are disjoint and that the
  held-out frame handles never appear among the thumbnail channels. I re-checked
  this: the channel overlap is empty.
- **Thumbnails:** training uses `~v2-youtube-eval.test`, so the frozen 66 are
  excluded. That split is by video, not channel, as documented.
- **LCO / channel refits:** these use `corpus_keep=~subset` and
  `thumbnail_keep=~subset`, so the whole category or channel is removed from every
  head's training.
- **Test-set reuse (caveat).** The held-out set is not fresh. The single-seed v3
  (5809e53) was rejected on this same held-out recall, and the ensemble is the
  follow-up attempt. The recipe and aggregation were fixed before evaluation, and
  I found no seed or threshold search. Even so, this is a second look at the same
  test set.

## ONNX sanity

- Interface is the same as v2: `pixels` float32 `[batch,3,224,224]` → `probs`
  float32 `[batch,1]`, opset 17.
- All 121 tower initializers are byte-identical to the pinned shipped v2 (SHA
  matches `extension/models/safety.json`). Added: a packed fp32 `2560×1024`
  first layer, five 512-unit output vectors, then Sigmoid → `ReduceMean`. The
  averaging happens inside the graph.
- In-graph heads vs my cached-head forward pass on the graph's own embedding:
  max |Δ| 1.8e-7 over 370 frames.
- ONNX on pixels (CPU) vs cached-head on cached torch-fp16 embeddings: 364/370
  within 0.01, max |Δ| 0.071, mean 0.0007. Every one of the 370 decisions is the
  same. The gap comes from the tower (fp16 torch-CUDA vs fp16 ORT-CPU, embedding
  cosine ≥ 0.992), not from the heads.
- Size 87,137,810 B (+10.7% vs v2). SHA-256
  `14d5a6bb92bee51e8724e0273117b12774c39de29268a8d8d3f21bf18d798e5c`
  (the built `dist/models/safety/safety.onnx` matches).
- WebGPU re-bench (RTX 5070 Ti, 3 rounds × 25 runs), v2 vs v3e ms/batch:
  b1 8.5–8.6 vs 8.2–8.8; b2 10.2–10.3 vs 10.3–10.4; b4 12.6–13.2 vs 13.0–13.5;
  b8 20.7–22.1 vs 21.8–22.1. That is about 1.0–1.05×, which confirms the claim.

## Runtime

- **Dev build:** `SAFETY_MODEL_PATH=<abs>/safety-v3e.onnx node build.mjs --dev`.
  The override hash was verified.
- **12-route trace:** `--watcher-ref=integrate/round-4 --replay=v2.json`.
  The watcher ref matters: base 5809e53 carries a `__DEV__`-only startup
  relaxation in `video.ts`, and pinning the shipped watcher keeps the comparison
  with `v2.json` fair.
  - **v2 (`v2.json`):** 4/12 blurred, 194 frames, 1 shown-then-blurred route,
    3 mid-watch transitions; safety p95 0.80, 10 frames ≥ 0.9.
  - **v3e, my run:** 0/12 blurred, 172 frames, 0 shown-then-blurred, 0 mid-watch
    transitions; max safety 0.035, every frame < 0.3.
  - **The builder's own run of the same command** (it finished just before mine):
    0/12, 175 frames, identical maximum.
  - None of the trace video IDs is in the frame-training set.
- **e2e GPU** (`TZ_TEST_PORT=18077`): **350 passed, 0 failed**. The safety model
  was running on WebGPU (806 classified).
- **e2e NO_GPU:** **350 passed, 0 failed**. With no WebGPU adapter the safety model
  is not loaded at all, so this run only shows the candidate does not break the
  fallback path.

## Caveats (state these if it ships)

1. **Recall is a tie, not a gain.** Full +3, dedup +3, drawn exactly at the −2
   floor (full and dedup), LCO lingerie −1. The paired per-seed SD is 4.66
   items, so all of these are inside noise. Read it as "no measurable NSFW
   regression", not "better".
2. **The frozen 66-thumbnail held-out set regresses 0 → 2.** The
   channel-held-out table improves (5 → 3 vs the paired v2e), but the genuinely
   frozen set got worse. Dataset photo SFW FP also rises 38 → 43 (dedup 35 → 40).
   Drawn SFW FP falls 94 → 92.
3. **Swimwear/lingerie gates compare against the paired v2 ensemble's LCO
   numbers, not against shipped v2.** Shipped v2 trained on those images. The
   LCO figures (107/120 and 66/84) show that unseen lingerie is caught about 79%
   of the time by either recipe.
4. **The frame win is in-domain.** The 1,460 training frames are YouTube frames
   from allowlisted channels. Held-out channels are excluded, but the
   evaluation corpus is small (370 frames / 37 videos / 8 channels) and screened by
   metadata. Very low safety scores on ordinary YouTube video are the intended
   effect. Scores outside YouTube (Reddit/X video, Twitch) have not been measured.
5. **No real-positive runtime test.** The e2e cannot load explicit content, so
   in-browser recall rests on the offline numbers plus the ONNX/heads equivalence
   shown above.
6. **The held-out set was looked at more than once** (see Leakage).

## Recommendation

It is reasonable to ship as safety-model v3 under the existing rule and
thresholds, with the caveats above written into CLAUDE.md and the README, if
the user accepts the 0 → 2 / 66 thumbnail regression in exchange for removing
almost all ordinary-video FPs (trace 4/12 → 0/12; frames 32 → 1 / 370). The
review did not publish the model or change `extension/models/safety.json`.

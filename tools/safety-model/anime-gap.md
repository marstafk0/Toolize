# Anime gap and label-noise measurements

2026-11-07. Numeric-only evaluation; no training images were displayed, extracted, copied as images or written as images.

## Selected rule

Balanced now blocks on `safety > 0.5 || sexy > 0.85 || hentai > 0.5`. The optional porn-beside-safety trigger is disabled (`null`) in every preset. Hentai thresholds are strict 0.4, balanced 0.5 and relaxed 0.7. Existing safety/sexy thresholds remain strict 0.3/0.75, balanced 0.5/0.85 and relaxed 0.75/0.95. Disabled porn thresholds have no numeric ordering; active thresholds retain strict < balanced < relaxed.

The original 16 candidates all exceed +0.5 percentage points (pp) Commons safe FP; their best FP cost is +1.061 pp. The expanded grid contains H=0.50..0.90 in steps of 0.05, each with P=none/0.92/0.95/0.97/0.99. Select by drawn misses recovered, then photographic misses recovered, then lower Commons FP. H=0.5/P=none wins within +0.5 pp, and also within +1.0 pp. There is no extra drawn recall available by spending the larger budget. P=0.97 with H=0.5 adds 9 Commons FPs but recovers the same 8 NSFW items; disabling P reduces that to 5 extra FPs.

The independent five-fold predictions support disabling porn too: at H=0.5, P=0.92/0.95/0.97/0.99 recover zero additional NSFW items and add 20/15/2/0 dataset SFW flags respectively versus hentai-only.

**The gain is modest and the dataset drawn-style FP cost is material.** This rule recovers 8/71 (11.27%) drawn misses under shipped weights, and 43/319 (13.48%) under independent five-fold heads. It does not close most of the drawn-style gap. Full-set drawn SFW FP rises by 2.896 pp; five-fold drawn SFW FP rises by 2.351 pp. The Commons cost remains within the requested budget.

## Current versus chosen rule

Shipped weights on all original dataset items (descriptive replay, **includes original training items**, not a held-out generalization estimate). Style proxy: NSFWJS drawing + hentai > 0.5; all other items are called photographic here.

| Partition | NSFW / SFW n | Current recall | Chosen recall | Current FP | Chosen FP |
|---|---:|---:|---:|---:|---:|
| Drawn style | 5,538 / 5,317 | 98.718% (5,467) | 98.862% (5,475) | 1.429% (76) | 4.326% (230) |
| Photographic | 21,261 / 15,881 | 99.887% (21,237) | 99.887% (21,237) | 0.510% (81) | 0.510% (81) |
| All dataset | 26,799 / 21,198 | 99.646% (26,704) | 99.675% (26,712) | 0.741% (157) | 1.467% (311) |
| Commons (flag / safe) | 270 / 1,885 | 83.333% (225) | 83.333% (225) | 1.592% (30) | 1.857% (35) |

The five additional Commons FPs are gym/sport (4) and hands/feet (1). Other categories add zero, including raw meat, medical skin and textures. Commons flag recall is unchanged at 225/270 (83.333%).

Independent five-fold heads, with every dataset item unseen by its scoring head (same architecture/objective; these are **not the shipped weights**):

| Partition | Current-rule recall | Chosen-rule recall | Current-rule FP | Chosen-rule FP |
|---|---:|---:|---:|---:|
| Drawn style | 94.240% (5,219) | 95.016% (5,262) | 6.112% (325) | 8.463% (450) |
| Photographic | 99.558% (21,167) | 99.558% (21,167) | 1.083% (172) | 1.083% (172) |
| All dataset | 98.459% (26,386) | 98.619% (26,429) | 2.345% (497) | 2.934% (622) |

## Suspected label noise

No original `test_keys.tsv` survived, so the noise check uses five-fold stratified OOF predictions, 512 hidden units, GELU, dropout 0.2, 40 epochs and the existing weighted/balanced training objective. Commons and 3,000 synthetic safe embeddings are in each fold. Fold counts are 9,600/9,600/9,599/9,599/9,599. Keys join exactly across embeddings, OOF predictions, shipped scores and NSFWJS scores; no failed items or missing scores.

The Commons rows use the current corpus exclusion list. The historical NudeNet drop list was unavailable and was not reconstructed for this diagnostic CV run.

| Direction | Items | Share of all 47,997 items |
|---|---:|---:|
| NSFW label, both models strongly safe | 182 | 0.3792% |
| SFW label, both models strongly explicit | 38 | 0.0792% |
| Total | 220 | 0.4584% |

The numeric criteria are exactly NSFW label + OOF P(block)<0.1 + max(NSFWJS porn,hentai,sexy)<0.2, or SFW label + OOF P(block)>0.9 + NSFWJS porn+hentai>0.6. The TSV has the requested nine columns, sorted by the weaker of the two models’ contrary confidence signals. These are suspects for the user to review, not verified label corrections.

Artifacts: `work/suspect-labels.tsv`, `work/suspect-drop.txt`, `work/oof.npz`, `work/shipped-probs.npz`, `work/nsfwjs-scores.json`, `work/gap-report.json`, and `work/candidate-rules.tsv`. All are gitignored. The suspect share is below 1%, so **no cleaned-head retraining or export was performed**. The CV heads are diagnostic only; no model was published and neither the model pin nor shipped ONNX was changed.

## Data discovery and reproduction

A metadata-only breadth-first search used PowerShell `Get-ChildItem -Recurse -Depth 0`, pruning excluded trees before recursion, on C:, D:, E: and F:. It inspected 173,861 directories in 143.7 seconds, with maximum depth 14 and no depth-limited remainder. Exclusions: Windows, Program Files, Program Files (x86), ProgramData, node_modules, .git, .t3, .pnpm-store, WinSxS, WindowsApps, recycle/system-volume directories and thumbnail caches. Reparse-point directories were skipped. Installed Python package trees were checked for open_clip before pruning. Inaccessible directories were not traversed. Full metadata matches, including unrelated NumPy/Parquet test fixtures and drawing source folders: `work/data-inventory.json`.

No `nsfw_detection_xl*`, usable training NPZ/head/split, 640m.onnx, HF dataset cache/Parquet data, large NSFW class folders, or nsfwjs/nsfw_data_scraper test set was found. The explicit HF cache paths were checked; the Hugging Face cache contained model artifacts only.

| Existing location | Files / items | Bytes | Finding |
|---|---:|---:|---|
| `C:\Users\boss_\.cache\huggingface` | 105 files, 0 images | 3,284,253,502 | Model cache; no dataset |
| `C:\Users\boss_\.cache\clip\ViT-L-14.pt` | 1 | 932,768,134 | Unrelated cached backbone |
| `C:\Users\boss_\AppData\Local\Temp\claude\e--GithubProjects-Toolize\1746cb99-86e7-4d2b-a642-8f0b95be05f4\scratchpad\nn` | 3 files | 905,339 | Partial open_clip environment; missing pyvenv.cfg, unusable |
| Same scratchpad: `final_results`, `nsfwjs_results`, `lists` | 0 files | 0 | Empty remnants |
| `E:\GithubProjects\Toolize\extension\.cache\safety-b2e56ebf48e49028.onnx` | 1 | 78,732,097 | Pinned shipped model |
| `E:\GithubProjects\Toolize\extension\test\corpus\safe` | 1,885 files | 416,221,235 | Commons safe corpus |
| Same corpus: `flag` | 339 files | 88,442,014 | 270 included by existing exclusions |
| Same corpus: `results` | 8 score JSON files | 4,804,331 | Latest reused below |

Only after the scan found no dataset, downloaded `https://huggingface.co/datasets/markandey14/nsfw_detection_xl/resolve/main/nsfw_detection_xl.zip?download=true` into this worktree’s `tools/safety-model/work/nsfw_detection_xl.zip`. It remains zipped: 5,603,078,235 bytes, 49,428 archive files including repository metadata, 47,997 image members (26,799 NSFW and 21,198 SFW). Download took 134.5 seconds. No images were extracted.

Reproduction uses OpenCLIP 3.3.0, RN50/openai, `TZ_SQUASH=1`, CUDA PyTorch 2.11.0+cu128 and an RTX 5070 Ti (16 GB). Dataset embeddings took **516.9 seconds (8m 37s)**; Commons embeddings 74.1 seconds. All 47,997 dataset members and 2,155 included Commons files decoded successfully. `xl.npz` is 93,314,210 bytes; `corpus.npz` 4,194,658; `synth.npz` 5,754,504; combined `corpus-train.npz` 9,955,819. Five-fold training took 52.2 seconds including startup (40.8 seconds inside the fold loop). Numeric NSFWJS scoring took 578.5 seconds (WebGL). Timing JSONs are in `work/`.

The shipped head was recovered from the pinned ONNX initializers, not retrained. NSFWJS uses `extension/dist/models/mobilenet_v2` and RGB/255 preprocessing. Dataset images are decoded and squashed to 224px with Pillow bicubic entirely in memory. This differs from browser canvas resampling/orientation handling; a Commons cross-check against saved browser safety scores has mean absolute difference 0.00733 and 99.16% threshold agreement, with a maximum per-item difference of 0.985. Thus the dataset replay is not pixel-for-pixel production inference. Original historical held-out README numbers are not re-labelled as new results.

Commons scores are reused from `E:\GithubProjects\Toolize\extension\test\corpus\results\2026-10-15T07-05-43-469Z.json` (1,308,257 bytes): nsfwjs-mobilenet_v2 + safety, all 2,155 rows have whole-image and safety scores. They are actual shipped-pipeline scores, including the original head’s Commons training overlap; the historical leave-one-category-out README table measures a different setting. The existing corpus runner was not rerun. The explicit dataset scorer creates no DOM images, canvas drawings, thumbnails or screenshots, and disables browser/HTTP caching.

## Full candidate table

Rates below are percentages. D = drawn style; P = photographic; C = Commons. Recall and FP refer to the labelled positive and safe sets respectively. Extra FP categories list counts, not filenames. Every candidate has the same safety>0.5 and sexy>0.85 base. A check mark means the Commons +0.5 pp budget is satisfied. The selected rule is marked **winner**.

### Original requested grid (16 rules)

| H | Porn P | D recall / FP | P recall / FP | C flag recall / safe FP | Extra C FP (pp) | ≤0.5 | Extra FP categories |
|---:|---:|---:|---:|---:|---:|:---:|---|
| 0.50 | 0.70 | 98.862 / 4.326 | 99.887 / 1.826 | 83.333 / 5.836 | 4.244 | no | gym-sport: 7; hands-feet: 26; home-listings: 4; medical-skin: 24; pink-animals: 2; textures: 17 |
| 0.50 | 0.80 | 98.862 / 4.326 | 99.887 / 1.096 | 83.333 / 4.403 | 2.812 | no | gym-sport: 6; hands-feet: 14; home-listings: 2; medical-skin: 16; pink-animals: 1; textures: 14 |
| 0.50 | 0.85 | 98.862 / 4.326 | 99.887 / 0.919 | 83.333 / 3.714 | 2.122 | no | gym-sport: 5; hands-feet: 11; home-listings: 1; medical-skin: 11; textures: 12 |
| 0.50 | 0.90 | 98.862 / 4.326 | 99.887 / 0.661 | 83.333 / 2.812 | 1.220 | no | gym-sport: 5; hands-feet: 8; medical-skin: 4; textures: 6 |
| 0.60 | 0.70 | 98.826 / 3.479 | 99.887 / 1.826 | 83.333 / 5.782 | 4.191 | no | gym-sport: 7; hands-feet: 25; home-listings: 4; medical-skin: 24; pink-animals: 2; textures: 17 |
| 0.60 | 0.80 | 98.826 / 3.479 | 99.887 / 1.096 | 83.333 / 4.350 | 2.759 | no | gym-sport: 6; hands-feet: 13; home-listings: 2; medical-skin: 16; pink-animals: 1; textures: 14 |
| 0.60 | 0.85 | 98.826 / 3.479 | 99.887 / 0.919 | 83.333 / 3.660 | 2.069 | no | gym-sport: 5; hands-feet: 10; home-listings: 1; medical-skin: 11; textures: 12 |
| 0.60 | 0.90 | 98.826 / 3.479 | 99.887 / 0.661 | 83.333 / 2.759 | 1.167 | no | gym-sport: 5; hands-feet: 7; medical-skin: 4; textures: 6 |
| 0.70 | 0.70 | 98.790 / 2.878 | 99.887 / 1.826 | 83.333 / 5.676 | 4.085 | no | gym-sport: 5; hands-feet: 25; home-listings: 4; medical-skin: 24; pink-animals: 2; textures: 17 |
| 0.70 | 0.80 | 98.790 / 2.878 | 99.887 / 1.096 | 83.333 / 4.244 | 2.653 | no | gym-sport: 4; hands-feet: 13; home-listings: 2; medical-skin: 16; pink-animals: 1; textures: 14 |
| 0.70 | 0.85 | 98.790 / 2.878 | 99.887 / 0.919 | 83.333 / 3.554 | 1.963 | no | gym-sport: 3; hands-feet: 10; home-listings: 1; medical-skin: 11; textures: 12 |
| 0.70 | 0.90 | 98.790 / 2.878 | 99.887 / 0.661 | 83.333 / 2.653 | 1.061 | no | gym-sport: 3; hands-feet: 7; medical-skin: 4; textures: 6 |
| 0.80 | 0.70 | 98.772 / 2.257 | 99.887 / 1.826 | 83.333 / 5.676 | 4.085 | no | gym-sport: 5; hands-feet: 25; home-listings: 4; medical-skin: 24; pink-animals: 2; textures: 17 |
| 0.80 | 0.80 | 98.772 / 2.257 | 99.887 / 1.096 | 83.333 / 4.244 | 2.653 | no | gym-sport: 4; hands-feet: 13; home-listings: 2; medical-skin: 16; pink-animals: 1; textures: 14 |
| 0.80 | 0.85 | 98.772 / 2.257 | 99.887 / 0.919 | 83.333 / 3.554 | 1.963 | no | gym-sport: 3; hands-feet: 10; home-listings: 1; medical-skin: 11; textures: 12 |
| 0.80 | 0.90 | 98.772 / 2.257 | 99.887 / 0.661 | 83.333 / 2.653 | 1.061 | no | gym-sport: 3; hands-feet: 7; medical-skin: 4; textures: 6 |

### Expanded grid including hentai-only (45 rules)

| H | Porn P | D recall / FP | P recall / FP | C flag recall / safe FP | Extra C FP (pp) | ≤0.5 | Extra FP categories |
|---:|---:|---:|---:|---:|---:|:---:|---|
| 0.50 | none | 98.862 / 4.326 | 99.887 / 0.510 | 83.333 / 1.857 | 0.265 | **winner** | gym-sport: 4; hands-feet: 1 |
| 0.50 | 0.92 | 98.862 / 4.326 | 99.887 / 0.649 | 83.333 / 2.599 | 1.008 | no | gym-sport: 5; hands-feet: 6; medical-skin: 4; textures: 4 |
| 0.50 | 0.95 | 98.862 / 4.326 | 99.887 / 0.604 | 83.333 / 2.387 | 0.796 | no | gym-sport: 5; hands-feet: 5; medical-skin: 3; textures: 2 |
| 0.50 | 0.97 | 98.862 / 4.326 | 99.887 / 0.523 | 83.333 / 2.069 | 0.477 | yes | gym-sport: 4; hands-feet: 4; textures: 1 |
| 0.50 | 0.99 | 98.862 / 4.326 | 99.887 / 0.510 | 83.333 / 1.857 | 0.265 | yes | gym-sport: 4; hands-feet: 1 |
| 0.55 | none | 98.826 / 3.818 | 99.887 / 0.510 | 83.333 / 1.804 | 0.212 | yes | gym-sport: 4 |
| 0.55 | 0.92 | 98.826 / 3.818 | 99.887 / 0.649 | 83.333 / 2.546 | 0.955 | no | gym-sport: 5; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.55 | 0.95 | 98.826 / 3.818 | 99.887 / 0.604 | 83.333 / 2.334 | 0.743 | no | gym-sport: 5; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.55 | 0.97 | 98.826 / 3.818 | 99.887 / 0.523 | 83.333 / 2.016 | 0.424 | yes | gym-sport: 4; hands-feet: 3; textures: 1 |
| 0.55 | 0.99 | 98.826 / 3.818 | 99.887 / 0.510 | 83.333 / 1.804 | 0.212 | yes | gym-sport: 4 |
| 0.60 | none | 98.826 / 3.479 | 99.887 / 0.510 | 83.333 / 1.804 | 0.212 | yes | gym-sport: 4 |
| 0.60 | 0.92 | 98.826 / 3.479 | 99.887 / 0.649 | 83.333 / 2.546 | 0.955 | no | gym-sport: 5; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.60 | 0.95 | 98.826 / 3.479 | 99.887 / 0.604 | 83.333 / 2.334 | 0.743 | no | gym-sport: 5; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.60 | 0.97 | 98.826 / 3.479 | 99.887 / 0.523 | 83.333 / 2.016 | 0.424 | yes | gym-sport: 4; hands-feet: 3; textures: 1 |
| 0.60 | 0.99 | 98.826 / 3.479 | 99.887 / 0.510 | 83.333 / 1.804 | 0.212 | yes | gym-sport: 4 |
| 0.65 | none | 98.790 / 3.216 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.65 | 0.92 | 98.790 / 3.216 | 99.887 / 0.649 | 83.333 / 2.440 | 0.849 | no | gym-sport: 3; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.65 | 0.95 | 98.790 / 3.216 | 99.887 / 0.604 | 83.333 / 2.228 | 0.637 | no | gym-sport: 3; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.65 | 0.97 | 98.790 / 3.216 | 99.887 / 0.523 | 83.333 / 1.910 | 0.318 | yes | gym-sport: 2; hands-feet: 3; textures: 1 |
| 0.65 | 0.99 | 98.790 / 3.216 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.70 | none | 98.790 / 2.878 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.70 | 0.92 | 98.790 / 2.878 | 99.887 / 0.649 | 83.333 / 2.440 | 0.849 | no | gym-sport: 3; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.70 | 0.95 | 98.790 / 2.878 | 99.887 / 0.604 | 83.333 / 2.228 | 0.637 | no | gym-sport: 3; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.70 | 0.97 | 98.790 / 2.878 | 99.887 / 0.523 | 83.333 / 1.910 | 0.318 | yes | gym-sport: 2; hands-feet: 3; textures: 1 |
| 0.70 | 0.99 | 98.790 / 2.878 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.75 | none | 98.790 / 2.483 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.75 | 0.92 | 98.790 / 2.483 | 99.887 / 0.649 | 83.333 / 2.440 | 0.849 | no | gym-sport: 3; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.75 | 0.95 | 98.790 / 2.483 | 99.887 / 0.604 | 83.333 / 2.228 | 0.637 | no | gym-sport: 3; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.75 | 0.97 | 98.790 / 2.483 | 99.887 / 0.523 | 83.333 / 1.910 | 0.318 | yes | gym-sport: 2; hands-feet: 3; textures: 1 |
| 0.75 | 0.99 | 98.790 / 2.483 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.80 | none | 98.772 / 2.257 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.80 | 0.92 | 98.772 / 2.257 | 99.887 / 0.649 | 83.333 / 2.440 | 0.849 | no | gym-sport: 3; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.80 | 0.95 | 98.772 / 2.257 | 99.887 / 0.604 | 83.333 / 2.228 | 0.637 | no | gym-sport: 3; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.80 | 0.97 | 98.772 / 2.257 | 99.887 / 0.523 | 83.333 / 1.910 | 0.318 | yes | gym-sport: 2; hands-feet: 3; textures: 1 |
| 0.80 | 0.99 | 98.772 / 2.257 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.85 | none | 98.754 / 2.050 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.85 | 0.92 | 98.754 / 2.050 | 99.887 / 0.649 | 83.333 / 2.440 | 0.849 | no | gym-sport: 3; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.85 | 0.95 | 98.754 / 2.050 | 99.887 / 0.604 | 83.333 / 2.228 | 0.637 | no | gym-sport: 3; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.85 | 0.97 | 98.754 / 2.050 | 99.887 / 0.523 | 83.333 / 1.910 | 0.318 | yes | gym-sport: 2; hands-feet: 3; textures: 1 |
| 0.85 | 0.99 | 98.754 / 2.050 | 99.887 / 0.510 | 83.333 / 1.698 | 0.106 | yes | gym-sport: 2 |
| 0.90 | none | 98.718 / 1.862 | 99.887 / 0.510 | 83.333 / 1.592 | 0.000 | yes | none |
| 0.90 | 0.92 | 98.718 / 1.862 | 99.887 / 0.649 | 83.333 / 2.334 | 0.743 | no | gym-sport: 1; hands-feet: 5; medical-skin: 4; textures: 4 |
| 0.90 | 0.95 | 98.718 / 1.862 | 99.887 / 0.604 | 83.333 / 2.122 | 0.531 | no | gym-sport: 1; hands-feet: 4; medical-skin: 3; textures: 2 |
| 0.90 | 0.97 | 98.718 / 1.862 | 99.887 / 0.523 | 83.333 / 1.804 | 0.212 | yes | hands-feet: 3; textures: 1 |
| 0.90 | 0.99 | 98.718 / 1.862 | 99.887 / 0.510 | 83.333 / 1.592 | 0.000 | yes | none |

## Validation

- `npm run typecheck`: passed.
- `node build.mjs --dev`: passed, with the pinned safety model included.
- Full `TZ_TEST_PORT=18677 node test/e2e.mjs`: **287 passed, 0 failed**; WebGL + WebGPU safety active.
- Full `NO_GPU=1 TZ_TEST_PORT=18677 node test/e2e.mjs`: **287 passed, 0 failed**; SIMD WASM fallback active.
- Both runs include hentai=0.9/safety=0.1 blocking, disabled-porn behavior, verdict reasons, threshold equality and ordering, optional enabled-porn policy behavior, and learning a site from three low-safety/high-hentai images.
- Numeric toy-embedding check: `--drop` filters dataset training and Commons, preserves the held-out split and suspect held-out keys, and CV still scores every evaluation key.
- Output audit: nine TSV columns, 220 unique suspects satisfying the exact criteria, all 47,997 score joins complete, 61 candidate rows and the selected Commons FP budget verified.
- Commons inference was reused from the latest complete score report as requested. No cleaned head was trained/exported; no model pin or shipped ONNX was changed.
- No files in `companion/`, the popup, shared words/settings or the content word filter were edited.

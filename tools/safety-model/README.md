# Safety model

The extension's main detector (since 0.9.0). OpenAI CLIP RN50's image tower plus a
small head trained to answer one question, "should this be hidden?". It runs in the
offscreen document through onnxruntime-web on WebGPU, about 2.5 ms per image in a
batch of 8. Without WebGPU, NSFWJS decides alone, as before. One WASM image takes
about 470 ms, too slow to run on every picture.

The file is too big for git. It lives in the GitHub release `safety-model-v1`, pinned by
SHA-256 in `extension/models/safety.json`, and `extension/build.mjs` downloads, verifies
and caches it in `extension/.cache/`.

## Results (balanced preset)

The first table is the 9,600 images held out from training (20% of the dataset, never
trained on), measured through the shipped extension pipeline:

| | NSFW caught | SFW blurred |
|---|---|---|
| NSFWJS alone (before) | 86.5% | 7.9% |
| Safety model + NSFWJS "sexy" | **98.1%** | **2.6%** |

The second table is the Commons hard negatives, each category scored by a head that
never saw that category:

| | Safe blurred | Swimwear/lingerie caught |
|---|---|---|
| NSFWJS alone | 10.1% | 74.0% |
| Safety model + NSFWJS "sexy" | **4.4%** | **84.3%** |

Raw meat, skin-tone food and pink animals: about 0%. Medical skin goes from 32% to 4%.

## Data

- `markandey14/nsfw_detection_xl` (Hugging Face, MIT): 48K images labelled nsfw
  (26.8K) or sfw (21.2K). The images are read straight from the zip in memory and only
  their embeddings are written.
- The Commons corpus: `extension/scripts/corpus-fetch.mjs` fetches about 2K hard
  negatives (raw meat, skin-tone food, medical skin, hands/feet, gym, faces, pink
  animals, textures, home listings, beaches) plus swimwear and lingerie, which are
  labelled "block". Commons pictures are weighted 3× in training.
- Synthetic content-free pictures (`synth.py`): 3,000 solid colours, gradients and
  smooth noise across every hue, all labelled safe. Without them the head blocked 2–9%
  of plain gradients, scoring skin-toned ones up to 1.00; e2e caught it on a test video
  fading through peach. On a fresh set (another seed) it now blocks 0%.
- Label filter (`labelfilter.py`, NudeNet 640m detections): a "safe" picture that shows
  exposed breasts, genitals or buttocks is dropped, so classical nudes in "human hands"
  are never taught as safe. A swimwear/lingerie picture with no person in it (logos,
  product shots, signs) is dropped too.

## Pipeline

```sh
python -m venv work/venv
work/venv/Scripts/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
work/venv/Scripts/pip install open_clip_torch onnx onnxruntime nudenet scikit-learn
PY=work/venv/Scripts/python

# embeddings, whole image squashed to the input size as the extension feeds it
TZ_SQUASH=1 $PY embed.py zip work/nsfw_detection_xl.zip RN50 openai work/xl.npz
TZ_SQUASH=1 $PY embed.py dir ../../extension/test/corpus RN50 openai work/corpus.npz
$PY nudenet_run.py ../../extension/test/corpus work/nn.json work/640m.onnx
$PY labelfilter.py work/nn.json work/drop.txt
$PY synth.py RN50 openai work/synth.npz 3000     # then merge into corpus.npz (label safe/synthetic)
SEED=2 $PY synth.py RN50 openai work/synth_eval.npz 2000 --head=work/head.json   # check after training

# train (80/20 split; corpus leave-one-category-out), save the head
$PY train.py work/xl.npz work/corpus.npz --drop work/drop.txt --hidden 512 \
    --split-out work/test_keys.tsv --probs-out work/probs.npz --save work/head.json

# one ONNX file (tower fp16, head fp32, CLIP normalisation inside):
# RGB 0..1 [B,3,224,224] -> P(block) [B,1]
$PY export.py RN50 openai work/head.json work/safety.onnx --fp16

# the shipped pipeline on the held-out images, served from the zip in memory
$PY zipserve.py work/nsfw_detection_xl.zip work/test_keys.tsv 8788 work/results &
CORPUS_SERVER=http://127.0.0.1:8788 npm run corpus     # in extension/
```

`evaluate.py` compares decision rules on both sets, joining NSFWJS scores from a corpus
run with the head's probabilities. `extension/test/onnx-bench.mjs` times a model on
WebGPU and WASM.

## Choices, measured

- **Backbone.** RN50 beat MobileCLIP-S2 on hard negatives the head never saw: 3.4%
  blurred vs 5.2%. It matched it on the held-out set (98.1% / 2.2% vs 98.4% / 2.3%),
  and it's faster. MobileCLIP is also off the table for licence reasons (see below).
  MobileCLIP-S1 was worse on hard cases.
- **Head.** An MLP with 512 hidden units beat a linear head.
- **Squash vs centre crop.** The whole image is squashed so nothing at the edges is cut
  off. That scored better than the crop the backbone was trained with.
- **NudeNet as a veto was rejected.** Both the 320n and 640m models cleared real
  lingerie photos with zero detections.
- **Gating behind NSFWJS was rejected.** It only adds misses.
- **Rule.** Block if `safety > t.safety`, or NSFWJS `sexy > t.sexyBesideSafety`
  (balanced 0.5 / 0.85; strict 0.3 / 0.75; relaxed 0.75 / 0.95).

## Licences

- CLIP RN50 weights: OpenAI, MIT.
- Dataset: MIT.
- NudeNet (AGPL-3.0): used only offline for the label filter; it doesn't ship.
- **MobileCLIP must not ship.** Its weights are under Apple's ML Research licence, which
  is non-commercial research only and excludes "use in any commercial product or
  service". Don't switch to it.

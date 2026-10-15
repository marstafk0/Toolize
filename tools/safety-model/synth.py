"""Synthetic content-free pictures (solid colours, linear/radial gradients, smooth noise,
across every hue incl. skin tones) as safe training negatives, embedded in memory.
  python synth.py <model> <pretrained> <out.npz> [n=3000] [--head head.json]
With --head, prints the head's P(block) on them instead of only saving.
"""
import sys, os, json, colorsys
import numpy as np
from PIL import Image, ImageFilter

sys.argv, opts = [a for a in sys.argv if not a.startswith('--')], [a for a in sys.argv if a.startswith('--')]
name, pretrained, out = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 3000
rng = np.random.default_rng(int(os.environ.get("SEED", 1)))


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return np.array([r, g, b]) * 255


def pic(i):
    w, h = int(rng.integers(160, 640)), int(rng.integers(160, 640))
    kind = i % 4
    c1 = hsl(rng.random(), rng.uniform(0.2, 0.9), rng.uniform(0.3, 0.8))
    c2 = hsl(rng.random(), rng.uniform(0.0, 0.8), rng.uniform(0.1, 0.9))
    if kind == 0:  # solid
        a = np.ones((h, w, 3)) * c1
    elif kind == 1:  # linear gradient, random angle
        th = rng.uniform(0, np.pi * 2)
        yy, xx = np.mgrid[0:h, 0:w]
        t = (xx * np.cos(th) + yy * np.sin(th)); t = (t - t.min()) / (np.ptp(t) + 1e-6)
        a = c1 * (1 - t[..., None]) + c2 * t[..., None]
    elif kind == 2:  # radial
        yy, xx = np.mgrid[0:h, 0:w]
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        t = np.hypot(xx - cx, yy - cy); t = t / (t.max() + 1e-6)
        a = c1 * (1 - t[..., None]) + c2 * t[..., None]
    else:  # smooth noise around a colour
        small = rng.normal(0, 40, (max(2, h // 40), max(2, w // 40), 3))
        noise = np.array(Image.fromarray(np.uint8(np.clip(small + 128, 0, 255))).resize((w, h), Image.BICUBIC)) - 128.0
        a = c1 + noise
    img = Image.fromarray(np.uint8(np.clip(a, 0, 255)))
    if rng.random() < 0.3:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(1, 6)))
    return img


import torch, open_clip
from torchvision import transforms as T
model, _, pre = open_clip.create_model_and_transforms(name, pretrained=pretrained)
model = model.eval().cuda().half()
size = model.visual.image_size
size = size[0] if isinstance(size, (tuple, list)) else size
rest = [t for t in pre.transforms if t.__class__.__name__ not in ('Resize', 'CenterCrop')]
pre = T.Compose([T.Resize((size, size), interpolation=T.InterpolationMode.BICUBIC)] + rest)
embs = []
for i in range(0, n, 256):
    x = torch.stack([pre(pic(j).convert('RGB')) for j in range(i, min(n, i + 256))]).cuda().half()
    with torch.no_grad():
        e = model.encode_image(x); e = e / e.norm(dim=-1, keepdim=True)
    embs.append(e.float().cpu().numpy())
E = np.concatenate(embs)
np.savez_compressed(out, emb=E.astype(np.float16), key=np.array([f'synth/{i}' for i in range(len(E))]), label=np.array(['safe/synthetic'] * len(E)))
print('saved', out, E.shape)
head = next((o.split('=', 1)[1] for o in opts if o.startswith('--head=')), None)
if head:
    h = json.load(open(head)); W = {k: torch.tensor(v) for k, v in h['weights'].items()}
    m = torch.nn.Sequential(torch.nn.Linear(W['0.weight'].shape[1], h['hidden']), torch.nn.GELU(), torch.nn.Dropout(0), torch.nn.Linear(h['hidden'], 1))
    m.load_state_dict(W)
    with torch.no_grad():
        p = torch.sigmoid(m(torch.tensor(E) * h['scale'])).squeeze(-1).numpy()
    kinds = ['solid', 'linear', 'radial', 'noise']
    for k in range(4):
        pk = p[k::4]
        print(f'  {kinds[k]:7s} blocked(>0.5) {np.mean(pk > 0.5) * 100:5.1f}%  max {pk.max():.2f}')

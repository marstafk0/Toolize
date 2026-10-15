"""Image embeddings for training a safety head. Images are decoded in memory (zip
members or corpus files) and only embeddings + labels are written.

  python embed.py list  <zip>                       # folder structure + counts
  python embed.py zip   <zip> <model> <pretrained> <out.npz> [max_per_class]
  python embed.py dir   <corpus_dir> <model> <pretrained> <out.npz>
"""
import io, os, sys, zipfile, collections, random
import numpy as np

IMG = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp')


def members(z):
    return [m for m in z.infolist() if not m.is_dir() and m.filename.lower().endswith(IMG)]


def label_of(path):
    # class = the folder that names one of the five classes, wherever it sits
    parts = [p.lower() for p in path.replace('\\', '/').split('/')[:-1]]
    for p in reversed(parts):
        for c in ('drawings', 'drawing', 'hentai', 'neutral', 'porn', 'sexy', 'nsfw', 'sfw', 'safe', 'unsafe'):
            if p == c:
                return 'drawing' if c == 'drawings' else c
    return '/'.join(parts[-2:]) or '?'


def cmd_list(zpath):
    z = zipfile.ZipFile(zpath)
    ms = members(z)
    dirs = collections.Counter('/'.join(m.filename.split('/')[:-1]) for m in ms)
    for d, n in sorted(dirs.items())[:60]:
        print(f'{n:7d}  {d}')
    print('images', len(ms), 'labels', collections.Counter(label_of(m.filename) for m in ms))


def load_model(name, pretrained):
    import torch, open_clip
    model, _, pre = open_clip.create_model_and_transforms(name, pretrained=pretrained)
    model = model.eval().cuda().half()
    if os.environ.get('TZ_SQUASH'):
        # The whole image squashed to the input size, edges included — what the
        # extension feeds the model (a centre crop would cut off the sides).
        from torchvision import transforms as T
        size = model.visual.image_size
        size = size[0] if isinstance(size, (tuple, list)) else size
        rest = [t for t in pre.transforms if t.__class__.__name__ not in ('Resize', 'CenterCrop')]
        pre = T.Compose([T.Resize((size, size), interpolation=T.InterpolationMode.BICUBIC)] + rest)
    return model, pre, torch


def run(items, read, name, pretrained, out):
    from PIL import Image
    model, pre, torch = load_model(name, pretrained)
    embs, keep, bad = [], [], 0
    batch, meta = [], []

    def flush():
        if not batch:
            return
        with torch.no_grad():
            x = torch.stack(batch).cuda().half()
            e = model.encode_image(x)
            e = e / e.norm(dim=-1, keepdim=True)
        embs.append(e.float().cpu().numpy())
        keep.extend(meta)
        batch.clear(); meta.clear()

    for i, (key, label) in enumerate(items):
        try:
            im = Image.open(io.BytesIO(read(key)))
            im.draft('RGB', (448, 448))
            batch.append(pre(im.convert('RGB')))
            meta.append((key, label))
        except Exception:
            bad += 1
            continue
        if len(batch) == 256:
            flush()
        if i % 5000 == 0:
            print(i, '/', len(items), 'bad', bad, flush=True)
    flush()
    e = np.concatenate(embs)
    np.savez_compressed(out, emb=e.astype(np.float16), key=np.array([k for k, _ in keep]), label=np.array([l for _, l in keep]))
    print('saved', out, e.shape, 'bad', bad, collections.Counter(l for _, l in keep))


def main():
    cmd = sys.argv[1]
    if cmd == 'list':
        return cmd_list(sys.argv[2])
    src, name, pretrained, out = sys.argv[2:6]
    if cmd == 'zip':
        cap = int(sys.argv[6]) if len(sys.argv) > 6 else 10**9
        z = zipfile.ZipFile(src)
        by = collections.defaultdict(list)
        for m in members(z):
            by[label_of(m.filename)].append(m.filename)
        random.seed(0)
        items = []
        for l, fs in by.items():
            random.shuffle(fs)
            items += [(f, l) for f in fs[:cap]]
        random.shuffle(items)
        run(items, z.read, name, pretrained, out)
    elif cmd == 'dir':
        items = []
        excl = set()
        ex = os.path.join(src, 'exclude.txt')
        if os.path.exists(ex):
            excl = {l.strip() for l in open(ex, encoding='utf8') if l.strip()}
        for kind in ('safe', 'flag'):
            for s in sorted(os.listdir(os.path.join(src, kind))):
                for f in sorted(os.listdir(os.path.join(src, kind, s))):
                    rel = f'{kind}/{s}/{f}'
                    if rel not in excl:
                        items.append((rel, f'{kind}/{s}'))
        run(items, lambda k: open(os.path.join(src, k), 'rb').read(), name, pretrained, out)


if __name__ == '__main__':
    main()

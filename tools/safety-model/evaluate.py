"""Final-rule candidates on both evaluation sets, joining NSFWJS scores with new-head probs.
  python combine2.py <heldout_nsfwjs_dir> <commons_results.json> <probs.npz> <drop.txt>
"""
import json, os, sys, urllib.parse
import numpy as np

hdir, cfile, pf, dropf = sys.argv[1:5]
p = np.load(pf)
CL = ['drawing', 'hentai', 'neutral', 'porn', 'sexy']


def nsfwjs_rows(images, index):
    n = len(index)
    W = np.zeros((n, 5)); T = np.zeros((n, 5)); has = np.zeros(n, bool)
    for im in images:
        i = index(im)
        if i is None or not im.get('whole'):
            continue
        W[i] = [im['whole'][c] for c in CL]; has[i] = True
        if im.get('tiles'):
            T[i] = [im['tiles'][c] for c in CL]
    return W, T, has


class Idx:
    def __init__(self, n, f): self.n, self.f = n, f
    def __len__(self): return self.n
    def __call__(self, im): return self.f(im)


# held-out
h = json.load(open(os.path.join(hdir, sorted(os.listdir(hdir))[-1])))
Ph, Yh = p['test_p'], p['test_y']
Wh, Th, _ = nsfwjs_rows(h['images'], Idx(len(Ph), lambda im: int(im['url'].rsplit('/', 1)[1])))
# commons
cr = json.load(open(cfile))
ckey = list(p['corpus_key']); pos = {k: i for i, k in enumerate(ckey)}
Pc, Yc = p['corpus_p'], p['corpus_y']
Wc, Tc, hasc = nsfwjs_rows(cr['images'], Idx(len(Pc), lambda im: pos.get(urllib.parse.unquote(im['url'].replace('/corpus/files/', '')))))
print('commons joined', hasc.sum(), 'of', len(Pc))


def cur(W, T):
    porn, hen, sexy = W[:, 3], W[:, 1], W[:, 4]
    b = (porn > .3) | (hen > .3)
    return (porn > .55) | (hen > .55) | (sexy > .75) | (b & ((T[:, 3] > .55) | (T[:, 1] > .55)))


rules = {
    'current NSFWJS': lambda W, T, P: cur(W, T),
    'new t=.5': lambda W, T, P: P > .5,
    'new t=.5 | NSFWJS sexy>.75': lambda W, T, P: (P > .5) | (W[:, 4] > .75),
    'new t=.5 | sexy>.75 | porn/hen>.9': lambda W, T, P: (P > .5) | (W[:, 4] > .75) | (W[:, 3] > .9) | (W[:, 1] > .9),
    'new t=.4 | NSFWJS sexy>.75': lambda W, T, P: (P > .4) | (W[:, 4] > .75),
    'new t=.6 | NSFWJS sexy>.75': lambda W, T, P: (P > .6) | (W[:, 4] > .75),
    'new t=.7 | NSFWJS sexy>.75': lambda W, T, P: (P > .7) | (W[:, 4] > .75),
    'new t=.5 | NSFWJS sexy>.85': lambda W, T, P: (P > .5) | (W[:, 4] > .85),
}
print(f"{'rule':38s} | held-out: caught  FP | commons: safe-FP  swim/lingerie caught")
for k, f in rules.items():
    bh = f(Wh, Th, Ph); bc = f(Wc, Tc, Pc)
    print(f'{k:38s} |   {bh[Yh==1].mean()*100:6.2f} {bh[Yh==0].mean()*100:5.2f} |   {bc[Yc==0].mean()*100:6.2f}   {bc[Yc==1].mean()*100:6.2f}')

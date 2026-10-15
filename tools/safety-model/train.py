"""Train + evaluate a binary block/safe head on frozen image embeddings.

  python train.py <dataset.npz> <corpus.npz> --drop drop.txt [--hidden 0] [--hard-weight 3]
                  [--save head.json] [--split-out test_keys.tsv] [--probs-out probs.npz]

Dataset labels: nsfw -> block, sfw -> safe. 80/20 split (seed 0); the 20% is never
trained on. Corpus (Commons): safe/* -> safe, flag/* (swimwear, lingerie) -> block,
evaluated leave-one-category-out so each picture is scored by a head that never saw
its category.
"""
import argparse, json, collections
import numpy as np
import torch, torch.nn as nn

ap = argparse.ArgumentParser()
ap.add_argument('dataset'); ap.add_argument('corpus')
ap.add_argument('--drop')
ap.add_argument('--hard-weight', type=float, default=3.0)
ap.add_argument('--hidden', type=int, default=0)
ap.add_argument('--epochs', type=int, default=40)
ap.add_argument('--save'); ap.add_argument('--split-out'); ap.add_argument('--probs-out')
a = ap.parse_args()
torch.manual_seed(0)

d = np.load(a.dataset)
X = d['emb'].astype(np.float32); keys = d['key']
y = (d['label'] == 'nsfw').astype(np.int64)
ok = np.isin(d['label'], ['nsfw', 'sfw'])
X, y, keys = X[ok], y[ok], keys[ok]
idx = np.random.default_rng(0).permutation(len(X)); cut = int(len(X) * 0.8)
tr, te = idx[:cut], idx[cut:]
if a.split_out:
    with open(a.split_out, 'w', encoding='utf8') as f:
        for i in te:
            f.write(f"{keys[i]}\t{'porn' if y[i] else 'neutral'}\n")

c = np.load(a.corpus)
CX = c['emb'].astype(np.float32); clab = c['label']; ckey = c['key']
if a.drop:
    dropped = {l.strip() for l in open(a.drop, encoding='utf8') if l.strip()}
    keep = np.array([k not in dropped for k in ckey])
    CX, clab, ckey = CX[keep], clab[keep], ckey[keep]
cy = np.array([0 if l.startswith('safe/') else 1 for l in clab])


def fit(Xtr, ytr, wtr):
    dev = 'cuda'
    Xt = torch.tensor(Xtr, device=dev); yt = torch.tensor(ytr, device=dev, dtype=torch.float32)
    wt = torch.tensor(wtr, device=dev, dtype=torch.float32)
    dim = Xt.shape[1]
    m = (nn.Sequential(nn.Linear(dim, a.hidden), nn.GELU(), nn.Dropout(0.2), nn.Linear(a.hidden, 1)) if a.hidden else nn.Linear(dim, 1)).to(dev)
    pos = yt.mean()
    cw = torch.where(yt > 0, 0.5 / pos, 0.5 / (1 - pos))  # balance classes
    opt = torch.optim.AdamW(m.parameters(), lr=2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.epochs)
    n = len(Xt)
    for ep in range(a.epochs):
        m.train()
        perm = torch.randperm(n, device=dev)
        for i in range(0, n, 512):
            b = perm[i:i + 512]
            logit = m(Xt[b] * 10).squeeze(-1)
            loss = (nn.functional.binary_cross_entropy_with_logits(logit, yt[b], reduction='none') * cw[b] * wt[b]).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
    m.eval()
    return m


def prob(m, X):
    with torch.no_grad():
        return torch.sigmoid(m(torch.tensor(X, device='cuda') * 10).squeeze(-1)).cpu().numpy()


cats = sorted(set(clab))
Pc = np.zeros(len(CX), np.float32)
for cat in cats:
    o = clab != cat
    m = fit(np.concatenate([X[tr], CX[o]]), np.concatenate([y[tr], cy[o]]), np.concatenate([np.ones(len(tr)), np.full(o.sum(), a.hard_weight)]))
    Pc[clab == cat] = prob(m, CX[clab == cat])
m = fit(np.concatenate([X[tr], CX]), np.concatenate([y[tr], cy]), np.concatenate([np.ones(len(tr)), np.full(len(CX), a.hard_weight)]))
Pd = prob(m, X[te]); yd = y[te]

print(f'dataset test n={len(te)} (nsfw {yd.sum()}, sfw {(1-yd).sum()}); corpus n={len(CX)}')
print('  t   | nsfw-recall  sfw-FP | commons-safe-FP  swim/lingerie-FN')
safe_c = cy == 0
for t in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
    print(f' {t:.1f}  |   {(Pd[yd==1]>t).mean()*100:6.2f}   {(Pd[yd==0]>t).mean()*100:6.2f} |     {(Pc[safe_c]>t).mean()*100:6.2f}          {(Pc[~safe_c]<=t).mean()*100:6.2f}')
print('commons per category at t=0.5:')
for cat in cats:
    s = clab == cat
    print(f'  {cat:22s} n={s.sum():4d} blocked {(Pc[s]>0.5).mean()*100:5.1f}%')
if a.probs_out:
    np.savez(a.probs_out, test_key=keys[te], test_y=yd, test_p=Pd, corpus_key=ckey, corpus_y=cy, corpus_p=Pc)
if a.save:
    W = {k: v.detach().cpu().numpy().round(6).tolist() for k, v in m.state_dict().items()}
    json.dump({'scale': 10, 'hidden': a.hidden, 'weights': W}, open(a.save, 'w'))
    print('saved head', a.save)

"""Train an unpublished hard-negative candidate using embeddings only.

Keeps the original seed-0 80/20 split. Both thumbnail sizes and both resize paths
of a video always stay on the same side of a separate video-grouped 80/20 split.
Never opens original explicit images; reads only existing numeric embeddings.
python retrain-youtube.py <existing-work> <local-work> <audit-dir>
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

base, work, audit = map(Path, sys.argv[1:])
torch.set_num_threads(8)
started = time.perf_counter()
d = np.load(base / 'xl.npz')
keep = np.isin(d['label'], ['nsfw', 'sfw'])
X = d['emb'][keep].astype(np.float32)
y = (d['label'][keep] == 'nsfw').astype(np.float32)
idx = np.random.default_rng(0).permutation(len(X))
tr, te = idx[:int(len(idx)*.8)], idx[int(len(idx)*.8):]
c = np.load(base / 'corpus-train.npz')
CX = c['emb'].astype(np.float32)
cy = np.array([not l.startswith('safe/') for l in c['label']], dtype=np.float32)
t = np.load(work / 'youtube.npz')

# Browser pixel embeddings, retaining the training tower's half precision.
browser_file = work / 'youtube-browser.npz'
if not browser_file.exists():
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms('RN50', pretrained='openai')
    model = model.eval().cuda().half()
    es = []
    mean = torch.tensor([.48145466,.4578275,.40821073],device='cuda').view(1,3,1,1)
    std = torch.tensor([.26862954,.26130258,.27577711],device='cuda').view(1,3,1,1)
    with torch.no_grad():
        for start in range(0,len(t['key']),32):
            pixels = np.stack([np.fromfile(audit/(str(k).split('/')[-1]+'.f32'),dtype='<f4').reshape(3,224,224)
                               for k in t['key'][start:start+32]])
            e = model.encode_image(((torch.from_numpy(pixels).cuda()-mean)/std).half())
            e = e/e.norm(dim=-1,keepdim=True)
            es.append(e.float().cpu().numpy())
    np.savez_compressed(browser_file,emb=np.concatenate(es).astype(np.float16),key=t['key'],label=t['label'])
    del model
browser = np.load(browser_file)['emb'].astype(np.float32)
videos = np.array([str(k).split('/')[-1].rsplit('--',1)[0] for k in t['key']])
heldout = set()
rng = np.random.default_rng(20261108)
for channel in sorted({v.split('--')[0] for v in videos}):
    group = np.array(sorted({v for v in videos if v.startswith(channel+'--')}))
    heldout.update(rng.permutation(group)[:max(1,round(len(group)*.2))])
test = np.array([v in heldout for v in videos])
TX = np.concatenate([t['emb'][~test].astype(np.float32),browser[~test]])
trainX = np.concatenate([X[tr],CX,TX])
trainy = np.concatenate([y[tr],cy,np.zeros(len(TX),np.float32)])
weights = np.concatenate([np.ones(len(tr)),np.full(len(CX),3),np.full(len(TX),3)])
torch.manual_seed(0)
m = nn.Sequential(nn.Linear(1024,512),nn.GELU(),nn.Dropout(.2),nn.Linear(512,1)).cuda()
Xt = torch.tensor(trainX,device='cuda'); yt = torch.tensor(trainy,device='cuda')
wt = torch.tensor(weights,device='cuda',dtype=torch.float32)
pos = yt.mean(); cw = torch.where(yt>0,.5/pos,.5/(1-pos))
opt = torch.optim.AdamW(m.parameters(),lr=.002,weight_decay=.0001)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt,40)
for epoch in range(40):
    m.train()
    perm = torch.randperm(len(Xt),device='cuda')
    for start in range(0,len(Xt),512):
        b = perm[start:start+512]
        loss = (nn.functional.binary_cross_entropy_with_logits(m(Xt[b]*10).squeeze(-1),yt[b],reduction='none')*wt[b]*cw[b]).mean()
        opt.zero_grad(); loss.backward(); opt.step()
    sched.step()
m.eval()

def prob(model,emb):
    with torch.no_grad():
        return torch.sigmoid(model(torch.tensor(emb,device='cuda')*10)).squeeze(-1).cpu().numpy()

old = nn.Sequential(nn.Linear(1024,512),nn.GELU(),nn.Dropout(0),nn.Linear(512,1)).cuda().eval()
h = json.loads((work/'youtube-v1.head.json').read_text())
old.load_state_dict({k:torch.tensor(v,device='cuda') for k,v in h['weights'].items()})
report = {'seconds':time.perf_counter()-started,'youtube_train_videos':len(set(videos))-len(heldout),
          'youtube_test_videos':len(heldout),'youtube_test_images':int(test.sum()),'original_test_images':len(te)}
for name,model in [('v1',old),('v2',m)]:
    pd = prob(model,X[te]); pt = prob(model,t['emb'].astype(np.float32)); pb=prob(model,browser)
    report[name] = {'nsfw_n':int(y[te].sum()),'nsfw_caught':int((pd[y[te]>0]>.5).sum()),
                    'sfw_n':int((y[te]==0).sum()),'sfw_fp':int((pd[y[te]==0]>.5).sum()),
                    'youtube_training_resize_test_fp':int((pt[test]>.5).sum()),
                    'youtube_browser_resize_test_fp':int((pb[test]>.5).sum()),
                    'youtube_training_resize_all_fp':int((pt>.5).sum()),'youtube_browser_resize_all_fp':int((pb>.5).sum())}
    np.savez(work/(name+'-youtube-eval.npz'),key=t['key'],test=test,training=pt,browser=pb,original_test=pd)
(work/'retrain-report.json').write_text(json.dumps(report,indent=2))
head={'scale':10,'hidden':512,'weights':{k:v.detach().cpu().numpy().round(6).tolist() for k,v in m.state_dict().items()}}
(work/'head-v2.json').write_text(json.dumps(head))
print(json.dumps(report,indent=2),flush=True)
if report['v2']['nsfw_caught'] < report['v1']['nsfw_caught']:
    raise SystemExit('Candidate rejected: held-out NSFW recall regressed. Do not publish.')

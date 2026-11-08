"""Recover the shipped MLP weights from ONNX and score embeddings (no image I/O).

python head-probs.py <shipped.onnx> <embeddings.npz> <out.npz>
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx.numpy_helper import to_array
import torch
from torch import nn

model, embeddings, out = sys.argv[1:]
graph = onnx.load(model)
weights = {v.name.removeprefix('head.'): torch.from_numpy(to_array(v).copy())
           for v in graph.graph.initializer if v.name.startswith('head.')}
hidden, dim = weights['0.weight'].shape
head = nn.Sequential(nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(0), nn.Linear(hidden, 1)).cuda().eval()
head.load_state_dict(weights)
d = np.load(embeddings)
with torch.no_grad():
    p = torch.sigmoid(head(torch.tensor(d['emb'].astype(np.float32), device='cuda') * 10)).squeeze(-1).cpu().numpy()
np.savez(out, key=d['key'], label=d['label'], p=p)
Path(out).with_suffix('.head.json').write_text(json.dumps({'scale': 10, 'hidden': hidden,
    'weights': {k: v.tolist() for k, v in weights.items()}}), encoding='utf8')
print('shipped-head scores', len(p), 'saved', out)

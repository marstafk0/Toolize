"""Export backbone image tower + trained head as one ONNX model for the browser.
Input  'pixels': float32 [B, 3, S, S], RGB in 0..1 (resize/crop done in JS).
Output 'probs' : float32 [B, 1] P(block) for a binary head (or [B, K] softmax).

  python export.py <model> <pretrained> <head.json> <out.onnx> [--fp16]
"""
import json, sys
import torch, torch.nn as nn, open_clip

name, pretrained, headf, out = sys.argv[1:5]
fp16 = '--fp16' in sys.argv
model, _, pre = open_clip.create_model_and_transforms(name, pretrained=pretrained)
model.eval()
norm = [t for t in pre.transforms if t.__class__.__name__ == 'Normalize']
mean = norm[0].mean if norm else (0.0, 0.0, 0.0)
std = norm[0].std if norm else (1.0, 1.0, 1.0)
size = model.visual.image_size if hasattr(model.visual, 'image_size') else 224
size = size[0] if isinstance(size, (tuple, list)) else size

h = json.load(open(headf))
W = {k: torch.tensor(v) for k, v in h['weights'].items()}
if h['hidden']:
    head = nn.Sequential(nn.Linear(W['0.weight'].shape[1], h['hidden']), nn.GELU(), nn.Dropout(0.0), nn.Linear(h['hidden'], W['3.weight'].shape[0]))
else:
    head = nn.Linear(W['weight'].shape[1], W['weight'].shape[0])
head.load_state_dict(W)
head.eval()


class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.visual = model.visual
        self.head = head
        self.register_buffer('mean', torch.tensor(mean).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor(std).view(1, 3, 1, 1))

    def forward(self, pixels):
        x = (pixels.to(self.mean.dtype) - self.mean) / self.std
        e = self.visual(x).float()
        e = e / e.norm(dim=-1, keepdim=True)
        z = self.head(e * h['scale'])
        return torch.sigmoid(z) if z.shape[-1] == 1 else torch.softmax(z, -1)


net = Net().eval()
x = torch.rand(2, 3, size, size)
with torch.no_grad():
    ref = net(x)
if fp16:
    # Half-precision tower straight from torch (the onnxconverter fp16 pass takes ages on
    # this graph); the head and the float32 input/output stay float32.
    net.visual.half(); net.mean = net.mean.half(); net.std = net.std.half()
torch.onnx.export(net, x, out, input_names=['pixels'], output_names=['probs'],
                  dynamic_axes={'pixels': {0: 'batch'}, 'probs': {0: 'batch'}}, opset_version=17, dynamo=False)
import onnxruntime as ort
s = ort.InferenceSession(out, providers=['CPUExecutionProvider'])
got = s.run(None, {'pixels': x.numpy()})[0]
print('exported', out, 'size', size, 'mean', mean, 'std', std, 'max diff vs torch', float(abs(got - ref.numpy()).max()))
json.dump({'model': name, 'pretrained': pretrained, 'size': size, 'classes': h.get('classes', ['block'])}, open(out + '.json', 'w'))

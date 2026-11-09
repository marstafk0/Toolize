"""Rebuild the missing NudeNet label filter without displaying or writing images.

python rebuild-corpus.py existing-work corpus-root local-work
Only the pre-existing corpus is decoded, in memory; outputs are numeric metadata.
"""
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort
from nudenet import NudeDetector


base, corpus, work = map(Path, sys.argv[1:])
data = np.load(base / 'corpus.npz')
detector = NudeDetector(model_path=str(work / '640m.onnx'), inference_resolution=640)
options = ort.SessionOptions()
options.intra_op_num_threads = 8
detector.onnx_session = ort.InferenceSession(str(work / '640m.onnx'), options, providers=['CPUExecutionProvider'])
exposed = {'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'BUTTOCKS_EXPOSED', 'ANUS_EXPOSED'}
output = work / 'nudenet-corpus.json'
detections = json.loads(output.read_text(encoding='utf8')) if output.exists() else {}
dropped = []
reasons = Counter()
started = time.perf_counter()
for index, key in enumerate(data['key']):
    key = str(key)
    if key not in detections:
        try:
            detections[key] = detector.detect((corpus / key).read_bytes())
        except Exception as error:
            detections[key] = {'error': type(error).__name__}
    found = detections[key]
    if not isinstance(found, list):
        dropped.append(key)
        reasons['unreadable'] += 1
    elif key.startswith('safe/') and any(row['class'] in exposed and row['score'] > .3 for row in found):
        dropped.append(key)
        reasons['safe nudity ' + key.split('/')[1]] += 1
    elif key.startswith('flag/') and not any(row['score'] > .3 for row in found):
        dropped.append(key)
        reasons['flag no person ' + key.split('/')[1]] += 1
    if index % 100 == 0:
        output.write_text(json.dumps(detections), encoding='utf8')
        print('filtered', index, 'of', len(data['key']), 'seconds', round(time.perf_counter() - started, 1), flush=True)
output.write_text(json.dumps(detections), encoding='utf8')
(work / 'commons-drop.txt').write_text(''.join(key + '\n' for key in sorted(dropped)), encoding='utf8')
keep = ~np.isin(data['key'], dropped)
synth = np.load(base / 'synth.npz')
np.savez_compressed(work / 'corpus-clean.npz', **{
    field: np.concatenate([data[field][keep], synth[field]]) for field in ('emb', 'key', 'label')})
report = {'total': len(keep), 'kept': int(keep.sum()), 'dropped': len(dropped),
          'seconds': time.perf_counter() - started, 'reasons': dict(reasons)}
(work / 'commons-filter.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print(json.dumps(report, indent=2), flush=True)

"""Join numeric thumbnail audit outputs; never reads image files.
python report-youtube.py <local-work> <artifacts> <corpus> <v1-corpus.json> <v2-corpus.json> <report-dir>
"""
import csv
import json
import sys
from pathlib import Path

import numpy as np

work, artifacts, corpus, v1path, v2path, dest = map(Path, sys.argv[1:])
dest.mkdir(parents=True,exist_ok=True)


def load(path):
    return json.loads(path.read_text(encoding='utf8'))


manifest = load(corpus/'safe/youtube-thumbs/manifest.json')
cpu = {r['file']:r for r in load(artifacts/'safety-audit/cpu.json')['rows']}
gpu = {r['file']:r for r in load(artifacts/'safety-audit/webgpu.json')['rows']}
wasm = {r['file']:r for r in load(artifacts/'safety-audit/wasm.json')['rows']}
f32cpu = {r['file']:r for r in load(artifacts/'safety-fp32/cpu.json')['rows']}
f32gpu = {r['file']:r for r in load(artifacts/'safety-fp32/webgpu.json')['rows']}
v2cpu = {r['file']:r for r in load(artifacts/'safety-v2/cpu.json')['rows']}
v2gpu = {r['file']:r for r in load(artifacts/'safety-v2/webgpu.json')['rows']}
boxes = {r['file']:r for r in load(artifacts/'safety-audit/letterbox.json')}
torch = np.load(work/'youtube-v1.npz')
tp = {str(k).split('/')[-1]:float(v) for k,v in zip(torch['key'],torch['p'])}
split = np.load(work/'v2-youtube-eval.npz')
test = {str(k).split('/')[-1]:bool(v) for k,v in zip(split['key'],split['test'])}
v1run, v2run = load(v1path),load(v2path)
pipeline1 = {r['url'].split('/')[-1]:r for r in v1run['images']}
pipeline2 = {r['url'].split('/')[-1]:r for r in v2run['images']}
rows = []
for meta in manifest:
    f = meta['file']
    row = dict(meta,youtube_heldout=test[f],v1_torch_training=tp[f],
               v1_cpu_training=cpu[f]['cpu_training'],v1_cpu_browser=cpu[f]['cpu_browser'],
               v1_webgpu=gpu[f]['single'],v1_wasm=wasm[f]['single'],
               webgpu_minus_cpu=gpu[f]['single']-cpu[f]['cpu_browser'],
               browser_minus_training=cpu[f]['cpu_browser']-cpu[f]['cpu_training'],
               v1_webgpu_mixed=gpu[f]['mixed'],v1_webgpu_padded=gpu[f]['padded'],
               fp32_cpu_browser=f32cpu[f]['cpu_browser'],fp32_webgpu=f32gpu[f]['single'],
               v2_cpu_training=v2cpu[f]['cpu_training'],v2_cpu_browser=v2cpu[f]['cpu_browser'],v2_webgpu=v2gpu[f]['single'],
               letterbox_trimmed_score=boxes[f]['trimmed'],letterbox_pixels=','.join(map(str,boxes[f]['bars'])),
               nsfwjs_neutral=pipeline1[f]['whole']['neutral'],nsfwjs_hentai=pipeline1[f]['whole']['hentai'],
               nsfwjs_porn=pipeline1[f]['whole']['porn'],nsfwjs_sexy=pipeline1[f]['whole']['sexy'],
               v1_pipeline_safety=pipeline1[f]['safety'],v2_pipeline_safety=pipeline2[f]['safety'])
    rows.append(row)
with (dest/'youtube-thumbnails.csv').open('w',newline='',encoding='utf8') as f:
    writer = csv.DictWriter(f,fieldnames=list(rows[0]))
    writer.writeheader();writer.writerows(rows)
columns = ['v1_torch_training','v1_cpu_training','v1_cpu_browser','v1_webgpu','v1_wasm','fp32_cpu_browser','fp32_webgpu',
           'v2_cpu_training','v2_cpu_browser','v2_webgpu']
summary = {'n':len(rows),'test_n':sum(test.values()),'fp':{k:sum(r[k]>.5 for r in rows) for k in columns},
           'test_fp':{k:sum(r[k]>.5 for r in rows if r['youtube_heldout']) for k in columns},
           'max_gpu_cpu':max(abs(r['webgpu_minus_cpu']) for r in rows),
           'max_resize':max(abs(r['browser_minus_training']) for r in rows),
           'max_gpu_cpu_fp32':max(abs(r['fp32_cpu_browser']-r['fp32_webgpu']) for r in rows),
           'max_wasm_cpu':max(abs(r['v1_wasm']-r['v1_cpu_browser']) for r in rows),
           'max_batch_delta':max(abs(r['v1_webgpu']-r['v1_webgpu_mixed']) for r in rows),
           'max_padding_delta':max(abs(r['v1_webgpu']-r['v1_webgpu_padded']) for r in rows),
           'pipeline_balanced_fp':[v1run['rows'][0]['wrong']['balanced'],v2run['rows'][0]['wrong']['balanced']],
           'v1_fp_by_channel':{c:sum(r['v1_webgpu']>.5 for r in rows if r['channel']==c) for c in sorted({r['channel'] for r in rows})},
           'letterbox_original_fp':sum(r['original']>.5 for r in boxes.values()),
           'letterbox_trimmed_fp':sum(r['trimmed']>.5 for r in boxes.values())}
(dest/'youtube-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
print(json.dumps(summary,indent=2))

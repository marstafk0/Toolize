"""Safe public thumbnail audit. Never reads the explicit image dataset.

fetch: download ordinary science/tech/cooking channel thumbnails + provenance.
cpu: score Pillow training preprocessing and exact browser-prepared RGB tensors.
Usage: python youtube-thumbs.py fetch <corpus/safe/youtube-thumbs> [video-count]
       python youtube-thumbs.py cpu <model.onnx> <thumbnail-dir> <audit-dir>
"""
import concurrent.futures
import csv
import io
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

# Public educational, technology and cooking channels; no search or adult feeds.
CHANNELS = {
    'veritasium': 'UCHnyfMqiRRG1u-2MsSQLbXA',
    'smarter-every-day': 'UC6107grRI4m0o2-emgoDnAA',
    'kurzgesagt': 'UCsXVk37bltHxD1rDPwtNM8Q',
    'numberphile': 'UCoxcjq-8xIDTYp3uz647V5A',
    '3blue1brown': 'UCYO_jab_esuFRV4b17AJtAw',
    'computerphile': 'UC9-y-6csu5WGm29I7JiwpnA',
    'tom-scott': 'UCBa659QWEk1AI4Tg--mrJ2A',
    'technology-connections': 'UCy0tKL1T7wFoYcxCe0xjN6Q',
    'mkbhd': 'UCBJycsmduvYEL83R_U4JriQ',
    'nasa': 'UCLA_DiR1FfKNvjuUpBHmylQ',
    'chef-john': 'UCRIZtPl9nb9RiXc9btSTQNw',
    'americas-test-kitchen': 'UCxAS_aK7sS2x_bqnlJHDSHw',
    'practical-engineering': 'UCMOqf8ab-42UUQIdVoKwjlQ',
    'standupmaths': 'UCSju5G2aFaWMqn-_0YBtq5A',
}


def download(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Toolize safe-thumbnail regression/1.0'})
    return urllib.request.urlopen(req, timeout=30).read()


def refetch(table, dest):
    """Recreate the exact audited set, without querying mutable RSS feeds."""
    dest.mkdir(parents=True,exist_ok=True)
    rows = list(csv.DictReader(table.open(encoding='utf8')))
    manifest = []
    for row in rows:
        if Path(row['file']).name != row['file']:
            raise ValueError('invalid thumbnail basename')
        path = dest/row['file']
        if not path.exists():
            path.write_bytes(download(row['url']))
        manifest.append({k:row[k] for k in ('file','url','channel','video','title','width','height','format')})
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
    print('restored',len(manifest),'safe-thumbnail manifest entries')


def embed_safe(src, out):
    # Reuse the exact training transform, but enumerate ONLY this safe manifest.
    # Never enumerate an existing corpus that might also contain explicit images.
    import os
    sys.dont_write_bytecode = True
    from embed import run
    os.environ['TZ_SQUASH'] = '1'
    manifest = json.loads((src/'manifest.json').read_text(encoding='utf8'))
    items = sorted(('safe/youtube-thumbs/'+r['file'],'safe/youtube-thumbs') for r in manifest)
    run(items,lambda key:(src/key.split('/')[-1]).read_bytes(),'RN50','openai',str(out))


def fetch(dest, limit):
    dest.mkdir(parents=True, exist_ok=True)
    entries = []
    ns = {'a': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015'}
    for channel, cid in CHANNELS.items():
        try:
            root = ET.fromstring(download(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}'))
            videos = [(e.findtext('yt:videoId', namespaces=ns), e.findtext('a:title', namespaces=ns))
                      for e in root.findall('a:entry', ns)]
            entries.extend({'channel': channel, 'video': vid, 'title': title} for vid, title in videos if vid)
            print(channel, len(videos), flush=True)
        except Exception as e:
            print(channel, str(e), flush=True)
    entries = entries[:limit]

    def get(meta, variant):
        url = f"https://i.ytimg.com/vi/{meta['video']}/{variant}.jpg"
        filename = f"{meta['channel']}--{meta['video']}--{variant}.jpg"
        path = dest / filename
        try:
            raw = path.read_bytes() if path.exists() else download(url)
            im = Image.open(io.BytesIO(raw))
            if im.width < 320:
                return None  # Missing-thumbnail placeholder.
            path.write_bytes(raw)
            return dict(meta, file=filename, url=url, width=im.width, height=im.height, format=im.format)
        except Exception as e:
            print('skip', filename, str(e), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(get, meta, variant) for meta in entries for variant in ('hq720', 'hqdefault')]
        rows = [r for f in futures if (r := f.result())]
    (dest / 'manifest.json').write_text(json.dumps(rows, indent=2), encoding='utf8')
    print('saved', len(rows), 'safe public thumbnails', flush=True)


def cpu(model, src, out):
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 8
    session = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
    manifest = json.loads((src / 'manifest.json').read_text(encoding='utf8'))
    rows = []
    for i, meta in enumerate(manifest):
        im = Image.open(src / meta['file'])
        im.draft('RGB', (448, 448))  # embed.py before TZ_SQUASH torchvision Resize.
        rgb = np.asarray(im.convert('RGB').resize((224, 224), Image.Resampling.BICUBIC))
        training = rgb.astype(np.float32).transpose(2, 0, 1) / 255
        browser = np.fromfile(out / (meta['file'] + '.f32'), dtype='<f4').reshape(3, 224, 224)
        p = session.run(None, {'pixels': np.stack([training, browser])})[0].ravel()
        rows.append(dict(meta, cpu_training=float(p[0]), cpu_browser=float(p[1]),
                         pixel_mean_abs_diff=float(np.abs(training - browser).mean())))
        if (i + 1) % 20 == 0:
            print('CPU', i + 1, '/', len(manifest), flush=True)
    # Batch composition: same pixels alone, with seven black images, with seven others.
    probe = min(rows, key=lambda r: abs(r['cpu_browser'] - 0.5))
    x = np.fromfile(out / (probe['file'] + '.f32'), dtype='<f4').reshape(3, 224, 224)
    others = [np.fromfile(out / (m['file'] + '.f32'), dtype='<f4').reshape(3, 224, 224) for m in manifest[1:8]]
    batch = {
        'file': probe['file'],
        'alone': float(session.run(None, {'pixels': x[None]})[0].ravel()[0]),
        'zeros': float(session.run(None, {'pixels': np.stack([x] + [np.zeros_like(x)] * 7)})[0].ravel()[0]),
        'others': float(session.run(None, {'pixels': np.stack([x] + others)})[0].ravel()[0]),
    }
    (out / 'cpu.json').write_text(json.dumps({'rows': rows, 'batch': batch}, indent=2), encoding='utf8')
    print('CPU results', len(rows), 'batch', batch, flush=True)


def codecs(src, dest):
    dest.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((src / 'manifest.json').read_text(encoding='utf8'))
    rows = []
    chosen = ['hPoJWjJ9Ao8', '3geDF-DAwpg', 'cDKPbMaLTA4', '_KWdCqpXB7A']
    for meta in manifest:
        if meta['video'] not in chosen or 'hq720' not in meta['file']:
            continue
        im = Image.open(src / meta['file']).convert('RGB')
        for fmt in ['JPEG', 'WEBP', 'AVIF']:
            filename = meta['file'] + '.' + fmt.lower()
            im.save(dest / filename, format=fmt, quality=95)
            rows.append(dict(meta, file=filename, format=fmt))
    (dest / 'manifest.json').write_text(json.dumps(rows, indent=2), encoding='utf8')
    print('saved', len(rows), 'safe codec probes')


def letterbox(model, src, out):
    import onnxruntime as ort
    opts = ort.SessionOptions(); opts.intra_op_num_threads = 8
    session = ort.InferenceSession(str(model),sess_options=opts,providers=['CPUExecutionProvider'])
    rows = []
    for meta in json.loads((src / 'manifest.json').read_text(encoding='utf8')):
        im = Image.open(src/meta['file']).convert('RGB')
        a = np.asarray(im)
        # Only trim near-black rows/columns (JPEG bars), at most 25% per side.
        dark_y = (a.max(axis=2)<20).mean(axis=1)>.98
        dark_x = (a.max(axis=2)<20).mean(axis=0)>.98
        def edge(v):
            n = 0
            while n < len(v)//4 and v[n]: n += 1
            return n
        l,r,t,b = edge(dark_x),edge(dark_x[::-1]),edge(dark_y),edge(dark_y[::-1])
        clean = im.crop((l,t,im.width-r,im.height-b))
        def tensor(img):
            return np.asarray(img.resize((224,224),Image.Resampling.BICUBIC)).astype(np.float32).transpose(2,0,1)/255
        p = session.run(None,{'pixels':np.stack([tensor(im),tensor(clean)])})[0].ravel()
        rows.append(dict(file=meta['file'],bars=[l,r,t,b],original=float(p[0]),trimmed=float(p[1])))
    (out/'letterbox.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
    print('letterbox', len(rows),'original/trimmed FPs',sum(r['original']>.5 for r in rows),sum(r['trimmed']>.5 for r in rows))


if __name__ == '__main__':
    if sys.argv[1] == 'fetch':
        fetch(Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 100)
    elif sys.argv[1] == 'cpu':
        cpu(*map(Path, sys.argv[2:5]))
    elif sys.argv[1] == 'codecs':
        codecs(*map(Path,sys.argv[2:4]))
    elif sys.argv[1] == 'letterbox':
        letterbox(*map(Path,sys.argv[2:5]))
    elif sys.argv[1] == 'embed':
        embed_safe(*map(Path,sys.argv[2:4]))
    elif sys.argv[1] == 'refetch':
        refetch(*map(Path,sys.argv[2:4]))

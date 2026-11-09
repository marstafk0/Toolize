"""Collect ordinary public videos from an explicit channel allowlist.

Metadata/downloads/frames stay under gitignored work/. No image is displayed.
python video-frames.py discover work/video-frames
python video-frames.py download work/video-frames
TZ_SQUASH=1 python video-frames.py embed work/video-frames
"""
import argparse
import concurrent.futures
import csv
import hashlib
import json
import re
from pathlib import Path

import numpy as np


CHANNELS = {
    'music': (['ThePianoGuys', 'LindseyStirling', 'PTXofficial', 'jacobcollier'], ['laufey']),
    'vlog': (['YesTheory', 'DudePerfect', 'ryan', 'airrack'], ['colinandsamir']),
    'cooking': (['foodwishes', 'PreppyKitchen', 'JKenjiLopezAlt', 'JoshuaWeissman'], ['aragusea']),
    'sports': (['NBA', 'FIFA', 'Olympics', 'MLB'], ['NFL']),
    'gaming': (['NintendoAmerica', 'NintendoUK', 'stampycat', 'TomScottGo'], ['PlayNintendo', 'Minecraft']),
    'beauty-fitness': (['LisaEldridge', 'WayneGoss', 'AlexandraAnele', 'BodyProjectchallenge'], ['FitnessBlender']),
    'news': (['PBSNewsHour', 'AssociatedPress', 'DWNews', 'CBSNews'], ['NBCNews']),
    'kids-animation': (['SesameStreet', 'PBSKIDS', 'Pixar', 'GKIDStv', 'TOHOanimation'], ['PokemonCoJp']),
}
REJECT = re.compile(r'\b(nud\w*|naked|sex\w*|porn\w*|lingerie|bikini|breast\w*|strip\w*|underwear|thong\w*|blood\w*|gore|corpse\w*|kill\w*|shoot\w*|dead|death|rape|abuse|swimsuit\w*|swimwear)\b', re.I)


def options():
    return {'quiet': True, 'no_warnings': True, 'socket_timeout': 20,
            'retries': 1, 'extractor_retries': 1, 'js_runtimes': {'node': {}},
            'cachedir': False}


def save(work, data):
    (work / 'videos.json').write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf8')


def discover_channel(spec):
    from yt_dlp import YoutubeDL
    category, split, handle = spec
    try:
        with YoutubeDL(dict(options(), extract_flat='in_playlist', playlistend=400 if handle == 'TOHOanimation' else 40)) as ydl:
            info = ydl.extract_info(f'https://www.youtube.com/@{handle}/videos', download=False)
        rows = []
        for entry in info.get('entries', []):
            if not entry or REJECT.search(entry.get('title', '')):
                continue
            if handle == 'TOHOanimation' and not re.search(r'Frieren|SPY|\u846c\u9001|\u30d2\u30ed\u30a2\u30ab|\u30c9\u30e9\u3048\u3082\u3093', entry.get('title', ''), re.I):
                continue
            duration = entry.get('duration') or 0
            if not 30 <= duration <= 1800 or entry.get('live_status') in ('is_live', 'is_upcoming'):
                continue
            rows.append({'id': entry['id'], 'title': entry['title'], 'duration': duration,
                         'channel': info.get('channel_id') or info['id'].removesuffix('uploads'),
                         'handle': handle, 'category': category, 'split': split,
                         'url': f"https://www.youtube.com/watch?v={entry['id']}"})
            if len(rows) == 5:
                break
        print('discovered', handle, split, len(rows), flush=True)
        return rows
    except Exception as error:
        print('unavailable channel', handle, str(error)[:160], flush=True)
        return []


def discover(work):
    specs = [(category, split, handle) for category, groups in CHANNELS.items()
             for split, handles in zip(('train', 'test'), groups) for handle in handles]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = [row for group in pool.map(discover_channel, specs) for row in group]
    assert len({row['id'] for row in rows}) == len(rows), 'duplicate video'
    assert not ({r['channel'] for r in rows if r['split'] == 'train'} &
                {r['channel'] for r in rows if r['split'] == 'test'}), 'channel leakage'
    save(work, rows)
    print('discovered total', len(rows), flush=True)


def download_one(args):
    from yt_dlp import YoutubeDL
    work, row = args
    target = work / 'media' / f"{row['id']}.mp4"
    def completed():
        if row.get('expected_sha256'):
            with target.open('rb') as video:
                digest = hashlib.file_digest(video, 'sha256').hexdigest()
            if digest != row['expected_sha256']:
                raise ValueError('frozen-manifest SHA-256 mismatch; do not silently change evaluation pixels')
        return dict(row, file=str(target.resolve()), downloaded=True)
    try:
        if target.exists():
            return completed()
        opts = dict(options(), format='best[ext=mp4][height<=360]/bestvideo[ext=mp4][height<=360]/worst[ext=mp4]',
                    outtmpl=str(target), max_filesize=100_000_000, noprogress=True,
                    writethumbnail=False, writeinfojson=False, fixup='never')
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(row['url'], download=False)
            if info.get('age_limit', 0) >= 18 or REJECT.search(info.get('title', '')):
                raise ValueError('not an ordinary-video candidate')
            if info.get('channel_id') != row['channel']:
                raise ValueError('channel identity mismatch')
            ydl.process_info(info)
        if not target.exists():
            raise ValueError('no downloaded file')
        print('downloaded', row['handle'], row['id'], target.stat().st_size, flush=True)
        return completed()
    except Exception as error:
        print('unavailable video', row['id'], str(error)[:160], flush=True)
        return dict(row, downloaded=False, error=str(error)[:300])


def download(work):
    rows = json.loads((work / 'videos.json').read_text(encoding='utf8'))
    (work / 'media').mkdir(exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = []
        for row in pool.map(download_one, ((work, row) for row in rows)):
            results.append(row)
            save(work, results + rows[len(results):])
    print('downloaded total', sum(r.get('downloaded', False) for r in results), flush=True)


def embed(work):
    import torch
    import embed as embedder
    torch.set_num_threads(8)
    frames = json.loads((work / 'frames.json').read_text(encoding='utf8'))
    items = [(row['key'], 'safe/video-frames') for row in frames]
    embedder.run(items, lambda key: (work / key).read_bytes(), 'RN50', 'openai', str(work / 'training.npz'))
    model, _, _ = embedder.load_model('RN50', 'openai')
    mean = torch.tensor([.48145466, .4578275, .40821073], device='cuda').view(1, 3, 1, 1)
    std = torch.tensor([.26862954, .26130258, .27577711], device='cuda').view(1, 3, 1, 1)
    embeddings = []
    with torch.no_grad():
        for start in range(0, len(frames), 64):
            pixels = np.stack([np.fromfile(work / row['pixels'], dtype='<f4').reshape(3, 224, 224)
                               for row in frames[start:start + 64]])
            vectors = model.encode_image(((torch.tensor(pixels, device='cuda') - mean) / std).half())
            vectors = vectors / vectors.norm(dim=-1, keepdim=True)
            embeddings.append(vectors.float().cpu().numpy())
    np.savez_compressed(work / 'browser.npz', emb=np.concatenate(embeddings).astype(np.float16),
                        key=np.array([row['key'] for row in frames]),
                        label=np.array(['safe/video-frames'] * len(frames)))
    print('embedded frames', len(frames), flush=True)


def refetch(work):
    fields = ['id', 'url', 'channel', 'handle', 'category', 'split', 'title', 'duration']
    with Path(__file__).with_name('video-frames.csv').open(encoding='utf8') as source:
        rows = [dict({field: row[field] for field in fields}, expected_sha256=row['sha256'])
                for row in csv.DictReader(source)]
    save(work, rows)
    download(work)


def manifest(work):
    rows = json.loads((work / 'videos.json').read_text(encoding='utf8'))
    frames = json.loads((work / 'frames.json').read_text(encoding='utf8'))
    destination = Path(__file__).with_name('video-frames.csv')
    fields = ['id', 'url', 'channel', 'handle', 'category', 'split', 'title', 'duration',
              'frames', 'width', 'height', 'first_sample', 'last_sample', 'sha256']
    with destination.open('w', encoding='utf8', newline='') as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            samples = [frame for frame in frames if frame['id'] == row['id']]
            if not samples:
                continue
            assert len(samples) == 10, 'incomplete video'
            with open(row['file'], 'rb') as video:
                digest = hashlib.file_digest(video, 'sha256').hexdigest()
            writer.writerow(dict({field: row[field] for field in fields[:8]}, frames=len(samples),
                width=samples[0]['width'], height=samples[0]['height'], first_sample=samples[0]['at'],
                last_sample=samples[-1]['at'], sha256=digest))
    print('wrote manifest', destination, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['discover', 'download', 'embed', 'manifest', 'refetch'])
    parser.add_argument('work', type=Path)
    args = parser.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)
    globals()[args.command](args.work)

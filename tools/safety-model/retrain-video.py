"""Unpublished, paired v2/v3 evaluation using frozen numeric embeddings only.

python retrain-video.py existing-work thumbnail-work local-work [--paired]
No original dataset image is opened. The seed-0 held-out dataset is never trained on.
"""
import argparse
import csv
import json
import time
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

import numpy as np
import onnx
import torch
from onnx import numpy_helper
from torch import nn


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('base', type=Path)
parser.add_argument('thumbnails', type=Path)
parser.add_argument('work', type=Path)
parser.add_argument('--paired', action='store_true')
parser.add_argument('--control', action='store_true')
args = parser.parse_args()
base, thumbnails, work = args.base, args.thumbnails, args.work
torch.set_num_threads(8)
started = time.perf_counter()
dataset = np.load(base / 'xl.npz')
valid = np.isin(dataset['label'], ['nsfw', 'sfw'])
features = dataset['emb'][valid].astype(np.float32)
keys = dataset['key'][valid]
labels = (dataset['label'][valid] == 'nsfw').astype(np.float32)
indices = np.random.default_rng(0).permutation(len(keys))
train, test = indices[:int(len(keys) * .8)], indices[int(len(keys) * .8):]
raw_scores = json.loads((base / 'nsfwjs-scores.json').read_text(encoding='utf8'))['rows']
score_map = {row['key']: row for row in raw_scores}
assert set(keys) == set(score_map), 'dataset score join incomplete'
scores = {name: np.array([score_map[key][name] for key in keys])
          for name in ('drawing', 'hentai', 'neutral', 'porn', 'sexy')}
drawn = scores['drawing'] + scores['hentai'] > .5
corpus = np.load(work / 'corpus-clean.npz')
corpus_x = corpus['emb'].astype(np.float32)
corpus_y = np.array([not label.startswith('safe/') for label in corpus['label']], dtype=np.float32)
corpus_rows = json.loads((base / 'commons-results.json').read_text(encoding='utf8'))['images']
corpus_scores = {unquote(row['url'].removeprefix('/corpus/files/')): row['whole'] for row in corpus_rows}
thumb = np.load(thumbnails / 'youtube.npz')
thumb_browser = np.load(thumbnails / 'youtube-browser.npz')
thumb_split = np.load(thumbnails / 'v2-youtube-eval.npz')
assert np.array_equal(thumb['key'], thumb_browser['key'])
assert np.array_equal(thumb['key'], thumb_split['key'])
thumb_train = ~thumb_split['test']
thumb_channels = np.array([str(key).split('/')[-1].split('--')[0] for key in thumb['key']])
thumb_csv = {row['file']: row for row in csv.DictReader(open(Path(__file__).with_name('youtube-thumbnails.csv'), encoding='utf8'))}
thumb_scores = {name: np.array([float(thumb_csv[str(key).split('/')[-1]]['nsfwjs_' + name]) for key in thumb['key']])
                for name in ('hentai', 'sexy')}
frame_work = work / 'video-frames'
frames = json.loads((frame_work / 'frames.json').read_text(encoding='utf8'))
frame_train = np.array([row['split'] == 'train' for row in frames])
frame_browser = np.load(frame_work / 'browser.npz')
frame_training = np.load(frame_work / 'training.npz')
assert np.array_equal(frame_browser['key'], frame_training['key'])
assert frame_browser['key'].tolist() == [row['key'] for row in frames]
train_channels = {row['channel'] for row in frames if row['split'] == 'train'}
test_channels = {row['channel'] for row in frames if row['split'] == 'test'}
assert not train_channels & test_channels, 'held-out frame channel leakage'
assert all(count == 10 for count in Counter(row['id'] for row in frames).values()), 'incomplete frame sampling'
normalize = lambda value: ''.join(character for character in value.lower() if character.isalnum())
assert not {normalize(row['handle']) for row in frames if row['split'] == 'test'} & {normalize(value) for value in thumb_channels}
frame_scores = {name: np.array([row['whole'][name] for row in frames]) for name in ('hentai', 'sexy')}


def network():
    return nn.Sequential(nn.Linear(1024, 512), nn.GELU(), nn.Dropout(.2), nn.Linear(512, 1)).cuda()


def fit(include_frames, corpus_keep=None, thumbnail_keep=None):
    torch.manual_seed(0)
    if corpus_keep is None:
        corpus_keep = np.ones(len(corpus_x), bool)
    if thumbnail_keep is None:
        thumbnail_keep = thumb_train
    extra = [corpus_x[corpus_keep], thumb['emb'][thumbnail_keep], thumb_browser['emb'][thumbnail_keep]]
    extra_y = [corpus_y[corpus_keep], np.zeros(thumbnail_keep.sum()), np.zeros(thumbnail_keep.sum())]
    if include_frames:
        extra.extend([frame_training['emb'][frame_train], frame_browser['emb'][frame_train]])
        extra_y.extend([np.zeros(frame_train.sum()), np.zeros(frame_train.sum())])
    training_x = np.concatenate([features[train], *extra]).astype(np.float32)
    training_y = np.concatenate([labels[train], *extra_y]).astype(np.float32)
    weights = np.concatenate([np.ones(len(train)), np.full(sum(len(part) for part in extra), 3)])
    tensor = torch.tensor(training_x, device='cuda')
    target = torch.tensor(training_y, device='cuda')
    weight = torch.tensor(weights, device='cuda', dtype=torch.float32)
    positive = target.mean()
    balance = torch.where(target > 0, .5 / positive, .5 / (1 - positive))
    model = network()
    optimizer = torch.optim.AdamW(model.parameters(), lr=.002, weight_decay=.0001)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, 40)
    for epoch in range(40):
        model.train()
        permutation = torch.randperm(len(tensor), device='cuda')
        for start in range(0, len(tensor), 512):
            batch = permutation[start:start + 512]
            logits = model(tensor[batch] * 10).squeeze(-1)
            loss = (nn.functional.binary_cross_entropy_with_logits(logits, target[batch], reduction='none') * weight[batch] * balance[batch]).mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        schedule.step()
    return model.eval()


def probability(model, vectors):
    with torch.no_grad():
        return torch.sigmoid(model(torch.tensor(vectors.astype(np.float32), device='cuda') * 10)).squeeze(-1).cpu().numpy()


def load_head(path):
    model = network().eval()
    if path.suffix == '.onnx':
        graph = onnx.load(str(path))
        state = {tensor.name[5:]: torch.tensor(numpy_helper.to_array(tensor).copy(), device='cuda')
                 for tensor in graph.graph.initializer if tensor.name.startswith('head.')}
    else:
        state = {name: torch.tensor(values, device='cuda') for name, values in json.loads(path.read_text())['weights'].items()}
    model.load_state_dict(state)
    return model


def full_rule(probabilities, source):
    return (probabilities > .5) | (source['sexy'] > .85) | (source['hentai'] > .5)


def dataset_metrics(probabilities):
    blocked = full_rule(probabilities, {name: values[test] for name, values in scores.items()})
    positive = labels[test] > 0
    result = {}
    for name, subset in [('all', np.ones(len(test), bool)), ('drawn', drawn[test]), ('photo', ~drawn[test])]:
        result[name] = {'nsfw': int((positive & subset).sum()), 'caught': int((blocked & positive & subset).sum()),
                        'sfw': int((~positive & subset).sum()), 'fp': int((blocked & ~positive & subset).sum())}
    ambiguous = (probabilities >= .4) & (probabilities <= .6)
    result['calibration'] = {'n_0.4_0.6': int(ambiguous.sum()), 'nsfw': int((ambiguous & positive).sum()),
                             'sfw': int((ambiguous & ~positive).sum())}
    return result


report_path = work / 'video-report.json'
report = json.loads(report_path.read_text(encoding='utf8')) if report_path.exists() else {}
report['recipe'] = {'seed': 0, 'epochs': 40, 'hidden': 512, 'hard_weight': 3, 'frame_weight': 3,
                    'original_train': len(train), 'original_test': len(test),
                    'frame_train_videos': len({row['id'] for row in frames if row['split'] == 'train'}),
                    'frame_test_videos': len({row['id'] for row in frames if row['split'] == 'test'}),
                    'frame_train_channels': len(train_channels), 'frame_test_channels': len(test_channels),
                    'frame_train_images': int(frame_train.sum()), 'frame_test_images': int((~frame_train).sum()),
                    'frame_categories': dict(Counter(row['category'] for row in frames)),
                    'commons_filter': json.loads((work / 'commons-filter.json').read_text())}


def save_report():
    report['seconds'] = time.perf_counter() - started
    report_path.write_text(json.dumps(report, indent=2), encoding='utf8')


if args.control:
    control = fit(False)
    report['clean_v2_control'] = dataset_metrics(probability(control, features[test]))
    vectors = frame_browser['emb'].astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    nearest = (vectors[~frame_train] @ vectors[frame_train].T).max(axis=1)
    report['frame_cross_channel_similarity'] = {'max_cosine': float(nearest.max()),
        'heldout_frames': len(nearest), 'nearest_training_cosine_ge_0.99': int((nearest >= .99).sum())}
    report['clean_v2_control']['frames_heldout'] = {
        'n': int((~frame_train).sum()),
        'full_rule_fp': int(full_rule(probability(control, frame_browser['emb']), frame_scores)[~frame_train].sum())}
    save_report()
    print(json.dumps(report['clean_v2_control'], indent=2), flush=True)
elif not args.paired:
    model = fit(True)
    head = {'scale': 10, 'hidden': 512, 'weights': {name: values.detach().cpu().numpy().round(6).tolist() for name, values in model.state_dict().items()}}
    (work / 'head-v3.json').write_text(json.dumps(head), encoding='utf8')
    model = load_head(work / 'head-v3.json')
    old = load_head(thumbnails / 'safety-v2.onnx')
    report['models'] = {}
    predictions = {}
    for name, candidate in [('v2', old), ('v3', model)]:
        dataset_p = probability(candidate, features[test])
        frame_p = probability(candidate, frame_browser['emb'])
        thumb_p = probability(candidate, thumb_browser['emb'])
        frame_blocked = full_rule(frame_p, frame_scores)
        thumb_blocked = full_rule(thumb_p, thumb_scores)
        held_frames = ~frame_train
        video_ids = {row['id'] for row in frames if row['split'] == 'test'}
        report['models'][name] = {'dataset': dataset_metrics(dataset_p),
            'frames_heldout': {'n': int(held_frames.sum()), 'safety_fp': int((frame_p[held_frames] > .5).sum()),
                               'full_rule_fp': int(frame_blocked[held_frames].sum()),
                               'videos': len(video_ids),
                               'videos_with_full_rule_fp': sum(any(frame_blocked[index] for index, row in enumerate(frames) if row['id'] == video_id) for video_id in video_ids)},
            'thumbnails_video_heldout': {'n': int((~thumb_train).sum()), 'safety_fp': int((thumb_p[~thumb_train] > .5).sum()),
                                          'full_rule_fp': int(thumb_blocked[~thumb_train].sum())}}
        predictions[name + '_dataset'] = dataset_p
        predictions[name + '_frames'] = frame_p
        predictions[name + '_thumbnails'] = thumb_p
    assert report['models']['v2']['dataset']['all']['caught'] == 5235, 'v2 reviewer baseline did not reproduce'
    report['recall_gate'] = report['models']['v3']['dataset']['all']['caught'] >= 5235
    np.savez_compressed(work / 'video-predictions.npz', dataset_key=keys[test], frame_key=frame_browser['key'], thumbnail_key=thumb['key'], **predictions)
    save_report()
    print(json.dumps(report, indent=2), flush=True)
else:
    paired = {'commons': {}, 'thumbnails': {}}
    for category in sorted(set(corpus['label']) - {'safe/synthetic'}):
        subset = corpus['label'] == category
        numeric = {name: np.array([corpus_scores[str(key)][name] for key in corpus['key'][subset]]) for name in ('hentai', 'sexy')}
        paired['commons'][str(category)] = {'n': int(subset.sum())}
        for version, include_frames in [('v2_recipe', False), ('v3_recipe', True)]:
            candidate = fit(include_frames, corpus_keep=~subset)
            probs = probability(candidate, corpus_x[subset])
            paired['commons'][str(category)][version] = {'blocked': int(full_rule(probs, numeric).sum()),
                                                        'safety_blocked': int((probs > .5).sum()),
                                                        'calibration_0.4_0.6': int(((probs >= .4) & (probs <= .6)).sum())}
        print('paired category', category, paired['commons'][str(category)], flush=True)
        report['paired'] = paired
        save_report()
    for channel in sorted(set(thumb_channels)):
        subset = thumb_channels == channel
        paired['thumbnails'][str(channel)] = {'n': int(subset.sum())}
        numeric = {name: values[subset] for name, values in thumb_scores.items()}
        for version, include_frames in [('v2_recipe', False), ('v3_recipe', True)]:
            candidate = fit(include_frames, thumbnail_keep=~subset)
            probs = probability(candidate, thumb_browser['emb'][subset])
            paired['thumbnails'][str(channel)][version] = {'full_rule_fp': int(full_rule(probs, numeric).sum()),
                                                          'safety_fp': int((probs > .5).sum())}
        print('paired channel', channel, paired['thumbnails'][str(channel)], flush=True)
        report['paired'] = paired
        save_report()
    print('paired evaluation complete', round(time.perf_counter() - started, 1), 'seconds', flush=True)

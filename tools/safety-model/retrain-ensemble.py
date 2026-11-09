"""Paired five-seed safety-v2/v3 audit using existing embeddings and scores only.

python retrain-ensemble.py base-work thumbnail-work video-work output-work
The frozen seed-0 split is independent of training seeds 0..4. No image is opened.
"""
import argparse
import csv
import json
import time
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from ensemble import SEEDS, SCALE, average_probabilities, export_ensemble, full_rule, load_heads, network, probabilities, save_heads, sha256, shipped_head


def fit(features, labels, weights, seed):
    torch.manual_seed(seed)
    tensor = torch.as_tensor(features, device='cuda', dtype=torch.float32)
    target = torch.as_tensor(labels, device='cuda', dtype=torch.float32)
    weight = torch.as_tensor(weights, device='cuda', dtype=torch.float32)
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
            logits = model(tensor[batch] * SCALE).squeeze(-1)
            loss = (nn.functional.binary_cross_entropy_with_logits(logits, target[batch], reduction='none')
                    * weight[batch] * balance[batch]).mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        schedule.step()
    model.eval()
    with torch.no_grad():
        for value in model.parameters():
            value.copy_(torch.from_numpy(value.cpu().numpy().round(6)).to(value.device))
    return model


def nearest_cosine(heldout, training):
    with torch.no_grad():
        training_tensor = nn.functional.normalize(torch.as_tensor(training, device='cuda', dtype=torch.float32), dim=1)
        maxima = []
        for start in range(0, len(heldout), 256):
            query = nn.functional.normalize(torch.as_tensor(heldout[start:start + 256], device='cuda', dtype=torch.float32), dim=1)
            maxima.append((query @ training_tensor.T).amax(dim=1).cpu().numpy())
    return np.concatenate(maxima)


def dataset_metrics(probability, labels, drawn, sexy, hentai, keep=None):
    if keep is None:
        keep = np.ones(len(labels), bool)
    positive = labels > 0
    blocked = full_rule(probability, sexy, hentai)
    result = {}
    for name, domain in [('all', np.ones(len(labels), bool)), ('drawn', drawn), ('photo', ~drawn)]:
        subset = keep & domain
        result[name] = {'nsfw': int((positive & subset).sum()), 'caught': int((blocked & positive & subset).sum()),
                        'sfw': int((~positive & subset).sum()), 'fp': int((blocked & ~positive & subset).sum())}
    ambiguous = (probability >= .4) & (probability <= .6) & keep
    result['calibration'] = {'n_0.4_0.6': int(ambiguous.sum()), 'nsfw': int((ambiguous & positive).sum()),
                             'sfw': int((ambiguous & ~positive).sum())}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('base', 'thumbnails', 'video', 'work'):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    base, thumbnails, video, work = args.base, args.thumbnails, args.video, args.work
    work.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(8)
    torch.backends.cuda.matmul.allow_tf32 = False
    started = time.perf_counter()
    dataset = np.load(base / 'xl.npz')
    valid = np.isin(dataset['label'], ['nsfw', 'sfw'])
    features = dataset['emb'][valid].astype(np.float32)
    keys = dataset['key'][valid]
    labels = (dataset['label'][valid] == 'nsfw').astype(np.float32)
    indices = np.random.default_rng(0).permutation(len(keys))
    train, test = indices[:int(len(keys) * .8)], indices[int(len(keys) * .8):]
    score_map = {row['key']: row for row in json.loads((base / 'nsfwjs-scores.json').read_text(encoding='utf8'))['rows']}
    assert set(keys) == set(score_map), 'dataset score join incomplete'
    scores = {name: np.array([score_map[str(key)][name] for key in keys]) for name in ('drawing', 'hentai', 'sexy')}
    drawn = scores['drawing'] + scores['hentai'] > .5
    corpus = np.load(video / 'corpus-clean.npz')
    corpus_x = corpus['emb'].astype(np.float32)
    corpus_y = np.array([not label.startswith('safe/') for label in corpus['label']], dtype=np.float32)
    corpus_rows = json.loads((base / 'commons-results.json').read_text(encoding='utf8'))['images']
    corpus_scores = {unquote(row['url'].removeprefix('/corpus/files/')): row['whole'] for row in corpus_rows}
    thumb = np.load(thumbnails / 'youtube.npz')
    thumb_browser = np.load(thumbnails / 'youtube-browser.npz')
    thumb_split = np.load(thumbnails / 'v2-youtube-eval.npz')
    assert np.array_equal(thumb['key'], thumb_browser['key']) and np.array_equal(thumb['key'], thumb_split['key'])
    thumb_train = ~thumb_split['test']
    thumb_channels = np.array([str(key).split('/')[-1].split('--')[0] for key in thumb['key']])
    with open(Path(__file__).with_name('youtube-thumbnails.csv'), encoding='utf8', newline='') as source:
        thumb_csv = {row['file']: row for row in csv.DictReader(source)}
    thumb_scores = {name: np.array([float(thumb_csv[str(key).split('/')[-1]]['nsfwjs_' + name]) for key in thumb['key']])
                    for name in ('hentai', 'sexy')}
    frames = json.loads((video / 'video-frames' / 'frames.json').read_text(encoding='utf8'))
    frame_train = np.array([row['split'] == 'train' for row in frames])
    frame_browser = np.load(video / 'video-frames' / 'browser.npz')
    frame_training = np.load(video / 'video-frames' / 'training.npz')
    assert np.array_equal(frame_browser['key'], frame_training['key'])
    assert frame_browser['key'].tolist() == [row['key'] for row in frames]
    assert not {row['channel'] for row in frames if row['split'] == 'train'} & {row['channel'] for row in frames if row['split'] == 'test'}
    assert all(count == 10 for count in Counter(row['id'] for row in frames).values())
    normalize = lambda value: ''.join(character for character in value.lower() if character.isalnum())
    assert not {normalize(row['handle']) for row in frames if row['split'] == 'test'} & {normalize(value) for value in thumb_channels}
    frame_scores = {name: np.array([row['whole'][name] for row in frames]) for name in ('hentai', 'sexy')}
    shipped_path = thumbnails / 'safety-v2.onnx'
    pin = json.loads((Path(__file__).parents[2] / 'extension' / 'models' / 'safety.json').read_text())
    assert sha256(shipped_path) == pin['sha256'], 'baseline is not shipped v2'
    inputs = [base / 'xl.npz', base / 'nsfwjs-scores.json', base / 'commons-results.json',
              video / 'corpus-clean.npz', video / 'commons-filter.json', thumbnails / 'youtube.npz',
              thumbnails / 'youtube-browser.npz', thumbnails / 'v2-youtube-eval.npz',
              video / 'video-frames' / 'frames.json', video / 'video-frames' / 'browser.npz',
              video / 'video-frames' / 'training.npz', Path(__file__).with_name('youtube-thumbnails.csv')]
    fingerprint = {str(path.resolve()): sha256(path) for path in inputs}
    experiment = {'seeds': list(SEEDS), 'aggregation': 'mean_probabilities', 'source_sha256': fingerprint,
                  'epochs': 40, 'scale': SCALE, 'hidden': 512, 'batch': 512, 'hard_weight': 3,
                  'frame_weight': 3, 'split_seed': 0, 'training_rows': len(train), 'heldout_rows': len(test),
                  'baseline_sha256': pin['sha256'], 'round_weights_decimals': 6,
                  'paired_v2_filter': 'same rebuilt Commons filter as v3; differs from shipped v2'}
    configuration = work / 'ensemble-experiment.json'
    if configuration.exists():
        assert json.loads(configuration.read_text()) == experiment, 'cached experiment inputs changed'
    else:
        configuration.write_text(json.dumps(experiment, indent=2), encoding='utf8')
    report = {'experiment': experiment, 'models': {}, 'paired': {'commons': {}, 'thumbnails': {}}}
    predictions = {'dataset_key': keys[test], 'frame_key': frame_browser['key'], 'thumbnail_key': thumb['key']}

    def save_report():
        report['seconds'] = time.perf_counter() - started
        (work / 'ensemble-report.json').write_text(json.dumps(report, indent=2), encoding='utf8')

    def training_data(include_frames, corpus_keep=None, thumbnail_keep=None):
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
        weights = np.concatenate([np.ones(len(train)), np.full(sum(len(part) for part in extra), 3)]).astype(np.float32)
        return training_x, training_y, weights

    union_training = training_data(True)[0]
    nearest_dataset = nearest_cosine(features[test], features[train])
    nearest_union = nearest_cosine(features[test], union_training)
    dedup = nearest_union <= .995
    predictions['nearest_original_train_cosine'] = nearest_dataset
    predictions['nearest_any_train_cosine'] = nearest_union
    predictions['deduplicated_keep'] = dedup
    report['deduplication'] = {'threshold': .995, 'comparison': 'drop cosine > threshold; float32 normalized embeddings',
        'training_reference': 'union of v2/v3 dataset, clean Commons, synthetic, training thumbnails and frames, both resize paths',
        'original_train_dropped': int((nearest_dataset > .995).sum()), 'any_train_dropped': int((~dedup).sum()),
        'retained': int(dedup.sum()), 'retained_nsfw': int(labels[test][dedup].sum())}

    def ensemble_models(version, include_frames, corpus_keep=None, thumbnail_keep=None, cache_label='main'):
        cache = work / 'ensemble-heads' / cache_label
        cache.mkdir(parents=True, exist_ok=True)
        head_path = cache / f'{version}.npz'
        if not head_path.exists():
            training_x, training_y, weights = training_data(include_frames, corpus_keep, thumbnail_keep)
            models = []
            for seed in SEEDS:
                seed_start = time.perf_counter()
                models.append(fit(training_x, training_y, weights, seed))
                print(f'{cache_label} {version} seed={seed} seconds={time.perf_counter() - seed_start:.2f}', flush=True)
            save_heads(head_path, models)
        return load_heads(head_path), head_path

    model_sets = {'v2_shipped': [shipped_head(shipped_path)]}
    for version, include_frames in [('v2_ensemble', False), ('v3_ensemble', True)]:
        models, head_path = ensemble_models(version, include_frames)
        model_sets[version] = models
        output = work / ('safety-v3e.onnx' if include_frames else 'safety-v2e.onnx')
        metadata = export_ensemble(shipped_path, head_path, output)
        session = ort.InferenceSession(str(output.with_suffix('.heads.onnx')), providers=['CPUExecutionProvider'])
        reference = average_probabilities(probabilities(models, features[test]))
        exported = session.run(None, {session.get_inputs()[0].name: features[test] * SCALE})[0].ravel()
        metadata['head_onnx_max_abs_difference'] = float(np.max(np.abs(exported - reference)))
        assert np.allclose(exported, reference, atol=2e-6), 'exported heads differ from evaluation weights'
        assert np.array_equal(exported > .5, reference > .5), 'export changed held-out threshold decisions'
        pixel_session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
        pixel_outputs = {}
        for batch in (1, 2, 8):
            tensor = np.random.default_rng(20261108 + batch).random((batch, 3, 224, 224), dtype=np.float32)
            values = pixel_session.run(None, {'pixels': tensor})[0]
            assert values.shape == (batch, 1) and values.dtype == np.float32
            assert np.isfinite(values).all() and ((values >= 0) & (values <= 1)).all()
            pixel_outputs[str(batch)] = values.ravel().tolist()
        metadata['cpu_random_tensor_batches'] = pixel_outputs
        report.setdefault('exports', {})[version] = metadata
        del pixel_session
    videos = {row['id'] for row in frames if row['split'] == 'test'}
    for version, models in model_sets.items():
        dataset_seeds = probabilities(models, features[test])
        frame_seeds = probabilities(models, frame_browser['emb'].astype(np.float32))
        thumb_seeds = probabilities(models, thumb_browser['emb'].astype(np.float32))
        dataset_p, frame_p, thumb_p = map(average_probabilities, (dataset_seeds, frame_seeds, thumb_seeds))
        frame_blocked = full_rule(frame_p, frame_scores['sexy'], frame_scores['hentai'])
        thumb_blocked = full_rule(thumb_p, thumb_scores['sexy'], thumb_scores['hentai'])
        arguments = (labels[test], drawn[test], scores['sexy'][test], scores['hentai'][test])
        report['models'][version] = {'dataset_full': dataset_metrics(dataset_p, *arguments),
            'dataset_deduplicated': dataset_metrics(dataset_p, *arguments, keep=dedup),
            'frames_heldout': {'n': int((~frame_train).sum()), 'fp': int(frame_blocked[~frame_train].sum()),
                'videos': len(videos), 'videos_with_fp': sum(any(frame_blocked[index] for index, row in enumerate(frames) if row['id'] == identifier) for identifier in videos)},
            'frozen_66_thumbnails': {'n': int((~thumb_train).sum()), 'fp': int(thumb_blocked[~thumb_train].sum())},
            'seed_metrics': [dataset_metrics(probability, *arguments) for probability in dataset_seeds]}
        predictions[version + '_dataset_seeds'] = dataset_seeds
        predictions[version + '_frame_seeds'] = frame_seeds
        predictions[version + '_thumbnail_seeds'] = thumb_seeds
        print(version, json.dumps(report['models'][version]), flush=True)
    assert report['models']['v2_shipped']['dataset_full']['all']['caught'] == 5235
    assert report['models']['v2_shipped']['dataset_full']['drawn']['caught'] == 1029
    assert report['models']['v2_shipped']['frames_heldout']['fp'] == 32
    assert report['models']['v2_shipped']['frozen_66_thumbnails']['fp'] == 0
    save_report()
    for category in sorted(set(corpus['label']) - {'safe/synthetic'}):
        subset = corpus['label'] == category
        numeric = {name: np.array([corpus_scores[str(key)][name] for key in corpus['key'][subset]]) for name in ('hentai', 'sexy')}
        entry = {'n': int(subset.sum())}
        for version, include_frames in [('v2_ensemble', False), ('v3_ensemble', True)]:
            models, unused_path = ensemble_models(version, include_frames, corpus_keep=~subset, cache_label=str(category).replace('/', '-'))
            per_seed = probabilities(models, corpus_x[subset])
            probability = average_probabilities(per_seed)
            entry[version] = {'blocked': int(full_rule(probability, numeric['sexy'], numeric['hentai']).sum()),
                'calibration_0.4_0.6': int(((probability >= .4) & (probability <= .6)).sum()),
                'seed_blocked': [int(full_rule(values, numeric['sexy'], numeric['hentai']).sum()) for values in per_seed]}
            predictions[version + '_commons_' + str(category)] = per_seed
        probability = average_probabilities(probabilities(model_sets['v2_shipped'], corpus_x[subset]))
        entry['v2_shipped_training_overlap'] = {'blocked': int(full_rule(probability, numeric['sexy'], numeric['hentai']).sum())}
        report['paired']['commons'][str(category)] = entry
        save_report()
        print('category', category, json.dumps(entry), flush=True)
    for channel in sorted(set(thumb_channels)):
        subset = thumb_channels == channel
        entry = {'n': int(subset.sum())}
        for version, include_frames in [('v2_ensemble', False), ('v3_ensemble', True)]:
            models, unused_path = ensemble_models(version, include_frames, thumbnail_keep=~subset, cache_label='channel-' + str(channel))
            per_seed = probabilities(models, thumb_browser['emb'][subset].astype(np.float32))
            probability = average_probabilities(per_seed)
            entry[version] = {'fp': int(full_rule(probability, thumb_scores['sexy'][subset], thumb_scores['hentai'][subset]).sum()),
                'seed_fp': [int(full_rule(values, thumb_scores['sexy'][subset], thumb_scores['hentai'][subset]).sum()) for values in per_seed]}
            predictions[version + '_channel_' + str(channel)] = per_seed
        probability = average_probabilities(probabilities(model_sets['v2_shipped'], thumb_browser['emb'][subset].astype(np.float32)))
        entry['v2_shipped_training_overlap'] = {'fp': int(full_rule(probability, thumb_scores['sexy'][subset], thumb_scores['hentai'][subset]).sum())}
        report['paired']['thumbnails'][str(channel)] = entry
        save_report()
        print('channel', channel, json.dumps(entry), flush=True)
    baseline = report['models']['v2_shipped']
    candidate = report['models']['v3_ensemble']
    commons = report['paired']['commons']
    report['gate'] = {
        'full_recall': candidate['dataset_full']['all']['caught'] >= baseline['dataset_full']['all']['caught'],
        'deduplicated_recall': candidate['dataset_deduplicated']['all']['caught'] >= baseline['dataset_deduplicated']['all']['caught'],
        'drawn_within_two_full': candidate['dataset_full']['drawn']['caught'] >= baseline['dataset_full']['drawn']['caught'] - 2,
        'drawn_within_two_deduplicated': candidate['dataset_deduplicated']['drawn']['caught'] >= baseline['dataset_deduplicated']['drawn']['caught'] - 2,
        'swimwear_within_two_paired': commons['flag/swimwear']['v3_ensemble']['blocked'] >= commons['flag/swimwear']['v2_ensemble']['blocked'] - 2,
        'lingerie_within_two_paired': commons['flag/lingerie']['v3_ensemble']['blocked'] >= commons['flag/lingerie']['v2_ensemble']['blocked'] - 2,
        'ordinary_frame_fp_halved': candidate['frames_heldout']['fp'] <= baseline['frames_heldout']['fp'] / 2}
    report['offline_gate_pass'] = all(report['gate'].values())
    np.savez_compressed(work / 'ensemble-predictions.npz', **predictions)
    save_report()
    print('OFFLINE GATE', json.dumps(report['gate']), 'PASS' if report['offline_gate_pass'] else 'FAIL', flush=True)


if __name__ == '__main__':
    main()

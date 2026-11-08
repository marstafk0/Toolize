"""Join numeric predictions, flag suspect labels, and compare policy candidates.

python analyze-gap.py <oof.npz> <shipped-probs.npz> <nsfwjs.json> <commons.json> <out-dir>
No image I/O. OOF predictions must cover every row; model scores join by exact key.
"""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

oof_file, shipped_file, nsfwjs_file, commons_file, out_dir = sys.argv[1:]
out = Path(out_dir)
out.mkdir(parents=True, exist_ok=True)
cv = np.load(oof_file)
shipped = np.load(shipped_file)
rows = json.loads(Path(nsfwjs_file).read_text(encoding='utf8'))['rows']
commons = json.loads(Path(commons_file).read_text(encoding='utf8'))
keys = cv['key'].tolist()
assert len(set(keys)) == len(keys)
by_key = {r['key']: r for r in rows}
current = dict(zip(shipped['key'], shipped['p']))
assert len(by_key) == len(rows) and set(keys) == set(by_key) == set(current), 'incomplete score join'
ordered = [by_key[k] for k in keys]
y = cv['y'].astype(bool)
assert all((r['label'] == 'nsfw') == bool(label) for r, label in zip(ordered, y))
assert np.isfinite(cv['p']).all() and np.all((cv['p'] >= 0) & (cv['p'] <= 1))
W = {c: np.array([r[c] for r in ordered]) for c in ('drawing', 'hentai', 'neutral', 'porn', 'sexy')}
P = np.array([current[k] for k in keys])
suspect_nsfw = y & (cv['p'] < .1) & (np.maximum.reduce([W['porn'], W['hentai'], W['sexy']]) < .2)
suspect_sfw = ~y & (cv['p'] > .9) & (W['porn'] + W['hentai'] > .6)
suspects = []
for i in np.flatnonzero(suspect_nsfw | suspect_sfw):
    # Confidence is the weaker of the two independent models' contrary signals.
    confidence = min(1 - cv['p'][i], 1 - max(W[c][i] for c in ('porn', 'hentai', 'sexy'))) if y[i] else min(cv['p'][i], W['porn'][i] + W['hentai'][i])
    suspects.append((float(confidence), i))
with (out / 'suspect-labels.tsv').open('w', encoding='utf8', newline='') as f:
    writer = csv.writer(f, delimiter='\t')
    writer.writerow(['key', 'label', 'p_block_oof', 'nsfwjs_porn', 'nsfwjs_hentai', 'nsfwjs_sexy', 'nsfwjs_neutral', 'nsfwjs_drawing', 'reason'])
    for _, i in sorted(suspects, key=lambda item: (-item[0], keys[item[1]])):
        writer.writerow([keys[i], 'nsfw' if y[i] else 'sfw', f'{cv["p"][i]:.8f}',
            *[f'{W[c][i]:.8f}' for c in ('porn', 'hentai', 'sexy', 'neutral', 'drawing')],
            'nsfw label; both models strongly safe' if y[i] else 'sfw label; both models strongly explicit'])
(out / 'suspect-drop.txt').write_text(''.join(keys[i] + '\n' for _, i in suspects), encoding='utf8')

C = [r for r in commons['images'] if r.get('whole') and r.get('safety') is not None]
assert len(C) == len(commons['images']), 'Commons scores missing'
CY = np.array([r['label'] == 'flag' for r in C])
CW = {c: np.array([r['whole'][c] for r in C]) for c in W}
CP = np.array([r['safety'] for r in C])
drawn = W['drawing'] + W['hentai'] > .5
base = (P > .5) | (W['sexy'] > .85)
cb = (CP > .5) | (CW['sexy'] > .85)


def metrics(blocked, labels, mask):
    positive, negative = mask & labels, mask & ~labels
    tp, fp = int((blocked & positive).sum()), int((blocked & negative).sum())
    nsfw, sfw = int(positive.sum()), int(negative.sum())
    return {'nsfw': nsfw, 'sfw': sfw, 'caught': tp, 'fp': fp,
            'recall': 100 * tp / nsfw if nsfw else None, 'fp_rate': 100 * fp / sfw if sfw else None}


partitions = {'drawn': drawn, 'photographic': ~drawn, 'all': np.ones(len(y), bool)}
baseline = {name: metrics(base, y, mask) for name, mask in partitions.items()}
baseline['commons'] = metrics(cb, CY, np.ones(len(C), bool))
rules = [(h, p, 'original') for h in (.5, .6, .7, .8) for p in (.7, .8, .85, .9)]
rules += [(h / 100, p, 'expanded') for h in range(50, 91, 5) for p in (None, .92, .95, .97, .99)]
candidates = []
for h, p, grid in rules:
    blocked = base | (W['hentai'] > h)
    cblocked = cb | (CW['hentai'] > h)
    if p is not None:
        blocked |= W['porn'] > p
        cblocked |= CW['porn'] > p
    result = {'hentai': h, 'porn': p, 'grid': grid}
    result.update({name: metrics(blocked, y, mask) for name, mask in partitions.items()})
    result['commons'] = metrics(cblocked, CY, np.ones(len(C), bool))
    result['extra_commons_fp_pp'] = result['commons']['fp_rate'] - baseline['commons']['fp_rate']
    result['extra_fp_categories'] = dict(sorted(Counter(r['category'] for i, r in enumerate(C) if not CY[i] and cblocked[i] and not cb[i]).items()))
    result['drawn_recovered'] = int((blocked & ~base & drawn & y).sum())
    result['photo_recovered'] = int((blocked & ~base & ~drawn & y).sum())
    candidates.append(result)


def best(budget):
    eligible = [r for r in candidates if r['extra_commons_fp_pp'] <= budget + 1e-9]
    return max(eligible, key=lambda r: (r['drawn_recovered'], r['photo_recovered'], -r['extra_commons_fp_pp'], r['hentai'])) if eligible else None


winner = best(.5)
fallback = False
if winner is None:
    misses = baseline['drawn']['nsfw'] - baseline['drawn']['caught']
    eligible = [r for r in candidates if r['porn'] is None and r['drawn_recovered'] >= misses / 2]
    if eligible:
        winner = max(eligible, key=lambda r: r['hentai'])
        fallback = True

summary = {'n': len(keys), 'noise': {'nsfw_to_safe': int(suspect_nsfw.sum()), 'sfw_to_explicit': int(suspect_sfw.sum()),
    'total': len(suspects), 'percent': 100 * len(suspects) / len(keys)}, 'baseline': baseline,
    'winner': winner, 'fallback_exceeds_half_pp': fallback, 'best_within_one_pp': best(1), 'candidates': candidates,
    'method': 'Dataset shipped MLP recovered from pinned ONNX on RN50/openai squash embeddings; noise uses 5-fold OOF. Commons reuses the shipped-pipeline score report. Dataset full-set metrics include original training items; not held-out generalization estimates.'}
cv_base = (cv['p'] > .5) | (W['sexy'] > .85)
cv_winner = cv_base.copy()
if winner:
    cv_winner |= W['hentai'] > winner['hentai']
    if winner['porn'] is not None:
        cv_winner |= W['porn'] > winner['porn']
summary['oof_rule_check'] = {
    'baseline': {name: metrics(cv_base, y, mask) for name, mask in partitions.items()},
    'winner': {name: metrics(cv_winner, y, mask) for name, mask in partitions.items()},
    'note': 'Independent five-fold heads, not the shipped weights. Every dataset item is unseen by its scoring head.'}
(out / 'gap-report.json').write_text(json.dumps(summary, indent=2), encoding='utf8')
fields = ['grid', 'hentai', 'porn', 'drawn_recall', 'drawn_fp', 'photo_recall', 'photo_fp', 'commons_fp', 'commons_flag_recall', 'extra_commons_fp_pp', 'drawn_recovered', 'photo_recovered', 'extra_fp_categories']
with (out / 'candidate-rules.tsv').open('w', encoding='utf8', newline='') as f:
    writer = csv.DictWriter(f, fields, delimiter='\t')
    writer.writeheader()
    for r in candidates:
        writer.writerow({'grid': r['grid'], 'hentai': r['hentai'], 'porn': r['porn'] if r['porn'] is not None else 'none',
            'drawn_recall': r['drawn']['recall'], 'drawn_fp': r['drawn']['fp_rate'], 'photo_recall': r['photographic']['recall'], 'photo_fp': r['photographic']['fp_rate'],
            'commons_fp': r['commons']['fp_rate'], 'commons_flag_recall': r['commons']['recall'],
            **{k: r[k] for k in ('extra_commons_fp_pp', 'drawn_recovered', 'photo_recovered')}, 'extra_fp_categories': json.dumps(r['extra_fp_categories'], sort_keys=True)})
print(json.dumps({k: v for k, v in summary.items() if k != 'candidates'}, indent=2))

"""Corpus keys not to train on, from NudeNet detections:
- safe/*: anything with exposed breasts, genitals, buttocks or anus (> 0.3): that's
  nudity, however artful, and must not be taught as safe.
- flag/*: nothing person-like detected at all (signs, logos, buildings, objects).
  python labelfilter.py nn_all.json drop.txt
"""
import json, sys, collections

EXPOSED = {'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'BUTTOCKS_EXPOSED', 'ANUS_EXPOSED'}
nn = json.load(open(sys.argv[1]))
drop, why = [], collections.Counter()
for k, dets in nn.items():
    if not isinstance(dets, list):
        drop.append(k); why['unreadable'] += 1; continue
    kind, cat = k.split('/')[:2]
    if kind == 'safe' and any(d['class'] in EXPOSED and d['score'] > 0.3 for d in dets):
        drop.append(k); why[f'safe nudity {cat}'] += 1
    elif kind == 'flag' and not any(d['score'] > 0.3 for d in dets):
        drop.append(k); why[f'flag no person {cat}'] += 1
open(sys.argv[2], 'w', encoding='utf8').write('\n'.join(drop) + '\n')
print(len(drop), 'dropped of', len(nn))
for w, n in why.most_common():
    print(f'  {n:4d} {w}')

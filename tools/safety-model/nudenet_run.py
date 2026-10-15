import json, os, sys
from nudenet import NudeDetector

corpus = sys.argv[1]
out = sys.argv[2]
det = NudeDetector(model_path=sys.argv[3], inference_resolution=640) if len(sys.argv) > 3 else NudeDetector()
res = {}
for label in ("safe", "flag"):
    for set_ in sorted(os.listdir(os.path.join(corpus, label))):
        d = os.path.join(corpus, label, set_)
        for f in sorted(os.listdir(d)):
            rel = f"{label}/{set_}/{f}"
            try:
                res[rel] = det.detect(os.path.join(d, f))
            except Exception as e:
                res[rel] = {"error": str(e)}
json.dump(res, open(out, "w"))
print(len(res), "images")

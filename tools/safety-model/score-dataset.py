"""Serve in-memory RGB tensors to score-dataset.mjs; never serves or writes images.

python score-dataset.py <dataset.zip> <embeddings.npz> <extension/dist> <worker.js> <port>
Only filenames/labels and numeric model scores are persisted by the Node client.
"""
import io
import json
import sys
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import numpy as np
from PIL import Image

archive, embeddings, dist, worker, port = sys.argv[1:]
z = zipfile.ZipFile(archive)
d = np.load(embeddings)
keys = d['key'].tolist()
labels = d['label'].tolist()
model_dir = Path(dist) / 'models' / 'mobilenet_v2'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/':
            return self.send(b'<!doctype html><title>Numeric model scoring</title><script src="/worker.js"></script>', 'text/html')
        if url.path == '/worker.js':
            return self.send(Path(worker).read_bytes(), 'application/javascript')
        if url.path == '/index':
            return self.send(json.dumps({'keys': keys, 'labels': labels}).encode(), 'application/json')
        if url.path.startswith('/models/'):
            name = url.path.removeprefix('/models/')
            if '/' in name or '\\' in name or name.startswith('.'):
                return self.send_error(404)
            path = model_dir / name
            if not path.is_file():
                return self.send_error(404)
            return self.send(path.read_bytes(), 'application/json' if name.endswith('.json') else 'application/octet-stream')
        if url.path == '/batch':
            query = parse_qs(url.query)
            start = int(query['start'][0])
            count = int(query['count'][0])
            if start < 0 or count < 1 or count > 8 or start + count > len(keys):
                return self.send_error(400)
            pixels = bytearray()
            for key in keys[start:start + count]:
                # Decode, squash and discard in memory, like embed.py. No image
                # endpoints, DOM image elements, canvas drawing or image files.
                with Image.open(io.BytesIO(z.read(key))) as image:
                    image.draft('RGB', (448, 448))
                    rgb = image.convert('RGB').resize((224, 224), Image.Resampling.BICUBIC)
                    pixels.extend(rgb.tobytes())
            return self.send(pixels, 'application/octet-stream')
        self.send_error(404)


print(f'tensor scorer: {len(keys)} items on 127.0.0.1:{port}', flush=True)
ThreadingHTTPServer(('127.0.0.1', int(port)), Handler).serve_forever()

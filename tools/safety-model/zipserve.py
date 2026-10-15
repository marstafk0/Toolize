"""Serves a held-out sample of a dataset zip to the extension's corpus page, straight
from the zip in memory (nothing extracted). Speaks the same API as serve-test.mjs:
  GET /corpus/index.json, GET /corpus/files/<n>, POST /corpus/results
  python zipserve.py <zip> <keys.txt> <port> <results_dir>
keys.txt: one "<member>\t<label>" per line (label safe|flag, category = class).
"""
import json, os, sys, zipfile, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

zpath, keyfile, port, outdir = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
z = zipfile.ZipFile(zpath)
rows = [l.rstrip('\n').split('\t') for l in open(keyfile, encoding='utf8') if l.strip()]
SAFE = {'neutral', 'drawing'}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('access-control-allow-origin', '*')
        self.send_header('access-control-allow-headers', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send(204, b'', 'text/plain')

    def do_GET(self):
        if self.path == '/corpus/index.json':
            idx = [{'url': f'/corpus/files/{i}', 'label': 'safe' if c in SAFE else 'flag', 'category': c, 'key': k}
                   for i, (k, c) in enumerate(rows)]
            return self.send(200, json.dumps(idx).encode(), 'application/json')
        if self.path.startswith('/corpus/files/'):
            i = int(self.path.rsplit('/', 1)[1])
            data = z.read(rows[i][0])
            ext = rows[i][0].lower().rsplit('.', 1)[-1]
            return self.send(200, data, 'image/png' if ext == 'png' else 'image/webp' if ext == 'webp' else 'image/jpeg')
        self.send(404, b'', 'text/plain')

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n)
        os.makedirs(outdir, exist_ok=True)
        f = os.path.join(outdir, datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
        open(f, 'wb').write(body)
        print('saved', f, flush=True)
        self.send(200, b'{}', 'application/json')


print('serving', len(rows), 'on', port, flush=True)
ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()

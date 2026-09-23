// Local test server for the blur-engine test pages and the image corpus.
//   node scripts/serve-test.mjs            -> http://localhost:8787 (+ :8788 as a 2nd origin)
//
// Routes
//   /pages/*                          static test pages (test/pages)
//   /img/<w>x<h>/<name>.png           synthetic gradient PNG (?cors=1 adds ACAO, ?delay=ms)
//   /img-referer/<w>x<h>/<name>.png   403 unless Referer is a localhost page (hotlink-protected CDN sim)
//   POST /upload/<name>.webm          stores a browser-recorded test clip (OS temp dir)
//   /media/<name>.webm                serves it back (?cors=1 adds ACAO)
//   /corpus/index.json                lists test/corpus/{safe,flag}/**  (your local images)
//   /corpus/files/*                   corpus images
//   POST /corpus/results              saves a regression run to test/corpus/results/
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = join(root, 'test/pages');
const corpusDir = join(root, 'test/corpus');
const mediaDir = join(tmpdir(), 'toolize-test-media');
const PORTS = [Number(process.env.PORT ?? 8787), Number(process.env.PORT ?? 8787) + 1];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']);

const pngCache = new Map();
function syntheticPng(w, h, name) {
  const key = `${w}x${h}/${name}`;
  if (!pngCache.has(key)) {
    let seed = 0;
    for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const a = [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255];
    const b = a.map((v) => 255 - v);
    pngCache.set(key, encodePng(w, h, (x, y) => {
      const t = (x / w + y / h) / 2;
      const stripe = ((x >> 4) + (y >> 4)) & 1 ? 12 : 0;
      return a.map((v, i) => Math.round(v * (1 - t) + b[i] * t) ^ stripe);
    }));
  }
  return pngCache.get(key);
}

function safeJoin(base, rel) {
  const p = normalize(join(base, decodeURIComponent(rel)));
  return p.startsWith(base + sep) || p === base ? p : null;
}

function listImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)))
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()) && statSync(f).isFile());
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const send = (status, body, type = 'text/plain', headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };

  const img = path.match(/^\/(img|img-referer)\/(\d+)x(\d+)\/([\w.-]+)\.png$/);
  if (img) {
    const [, kind, w, h, name] = img;
    if (kind === 'img-referer' && !/^http:\/\/(localhost|127\.0\.0\.1):/.test(req.headers.referer ?? '')) {
      return send(403, 'hotlink denied');
    }
    const headers = url.searchParams.get('cors') ? { 'access-control-allow-origin': '*' } : {};
    const body = syntheticPng(Math.min(+w, 4000), Math.min(+h, 4000), name);
    const delay = Number(url.searchParams.get('delay') ?? 0);
    return setTimeout(() => send(200, body, 'image/png', { ...headers, 'cache-control': 'max-age=3600' }), delay);
  }

  // Test clips are recorded in the browser (MediaRecorder) and parked in the OS temp
  // dir, so the repo stays free of binary fixtures.
  if (path.startsWith('/upload/') && req.method === 'POST') {
    const file = safeJoin(mediaDir, path.slice('/upload/'.length));
    if (!file) return send(400, 'bad name');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(file, Buffer.concat(chunks));
      send(200, JSON.stringify({ ok: true }), MIME['.json'], { 'access-control-allow-origin': '*' });
    });
    return;
  }
  if (path.startsWith('/upload/') && req.method === 'OPTIONS') {
    return send(204, '', 'text/plain', {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type',
    });
  }
  if (path.startsWith('/media/')) {
    const file = safeJoin(mediaDir, path.slice('/media/'.length));
    if (!file || !existsSync(file)) return send(404, 'not found');
    // No CORS header unless asked: that's what taints the page canvas and exercises
    // the offscreen whole-file video path.
    const headers = url.searchParams.get('cors') ? { 'access-control-allow-origin': '*' } : {};
    return send(200, readFileSync(file), 'video/webm', headers);
  }

  if (path === '/corpus/index.json') {
    const toUrl = (f) => `/corpus/files/${relative(corpusDir, f).split(sep).map(encodeURIComponent).join('/')}`;
    const entries = ['safe', 'flag'].flatMap((label) =>
      listImages(join(corpusDir, label)).map((f) => ({
        url: toUrl(f),
        label,
        category: relative(join(corpusDir, label), dirname(f)).split(sep)[0] || '(none)',
      })),
    );
    return send(200, JSON.stringify(entries), MIME['.json'], { 'access-control-allow-origin': '*' });
  }

  if (path === '/corpus/results' && req.method === 'OPTIONS') {
    return send(204, '', 'text/plain', {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type',
    });
  }
  if (path === '/corpus/results' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const dir = join(corpusDir, 'results');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(file, body);
      console.log(`saved corpus results -> ${relative(root, file)}`);
      send(200, JSON.stringify({ file: relative(root, file) }), MIME['.json'], { 'access-control-allow-origin': '*' });
    });
    return;
  }

  const base = path.startsWith('/corpus/files/') ? corpusDir : path.startsWith('/pages/') ? pagesDir : null;
  const rel = path.replace(/^\/corpus\/files\/|^\/pages\//, '');
  const file = base && safeJoin(base, rel || 'index.html');
  if (file && existsSync(file) && statSync(file).isFile()) {
    return send(200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', {
      'access-control-allow-origin': '*',
    });
  }
  if (path === '/') return send(302, '', 'text/plain', { location: '/pages/index.html' });
  send(404, 'not found');
}

for (const port of PORTS) createServer(handler).listen(port, () => console.log(`test server http://localhost:${port}`));

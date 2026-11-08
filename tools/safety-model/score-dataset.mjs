// Numeric-only NSFWJS inference. Python decodes zip members directly into memory;
// the browser receives tensors and creates no images, canvases or thumbnails.
// node score-dataset.mjs <python> <zip> <embeddings.npz> <out.json> [port]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../../extension');
const require = createRequire(join(extension, 'package.json'));
const { chromium } = require('playwright-core');
const { build } = require('esbuild');
const { findChromium } = await import(pathToFileURL(join(extension, 'test/chromium.mjs')));
const [python, zip, embeddings, output, port = '18679'] = process.argv.slice(2);
if (!output) throw new Error('expected python, zip, embeddings.npz, output.json, [port]');
const worker = join(here, 'work/numeric-scorer.js');
await build({
  stdin: { contents: `
    import * as tf from '@tensorflow/tfjs';
    window.load = async () => {
      tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true);
      if (!await tf.setBackend('webgl')) throw new Error('WebGL unavailable');
      await tf.ready(); tf.enableProdMode();
      const model = await tf.loadLayersModel('/models/model.json');
      window.score = async (start, count) => {
        const bytes = new Uint8Array(await (await fetch('/batch?start=' + start + '&count=' + count, {cache:'no-store'})).arrayBuffer());
        const out = tf.tidy(() => {
          const input = tf.tensor4d(bytes, [count, 224, 224, 3], 'int32');
          const padded = count < 8 ? tf.pad(input, [[0,8-count],[0,0],[0,0],[0,0]]) : input;
          return model.predict(tf.div(tf.cast(padded, 'float32'), 255));
        });
        const data = Array.from(out.dataSync()).slice(0, count * 5); out.dispose();
        return data;
      };
      return tf.getBackend();
    };`, resolveDir: extension },
  outfile: worker, bundle: true, format: 'iife', logLevel: 'silent',
});
const server = spawn(python, [join(here, 'score-dataset.py'), zip, embeddings, join(extension, 'dist'), worker, port], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
let browser;
try {
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('tensor server startup timed out')), 30_000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('tensor scorer:')) {clearTimeout(timer); done();} });
    server.once('exit', (code) => {clearTimeout(timer); reject(new Error('tensor server exited ' + code));});
    server.once('error', reject);
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
  browser = await chromium.launch({executablePath: findChromium(), headless: true, args: ['--disk-cache-size=0']});
  const context = await browser.newContext({serviceWorkers: 'block'});
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', {cacheDisabled: true});
  await page.goto(`http://127.0.0.1:${port}/`);
  const index = await page.evaluate(async () => (await fetch('/index', {cache:'no-store'})).json());
  const backend = await page.evaluate(() => window.load());
  const rows = [];
  if (process.env.TZ_RESUME && readFileSync(output, 'utf8')) {
    const previous = JSON.parse(readFileSync(output, 'utf8'));
    for (const row of previous.rows) {
      if (row.key !== index.keys[rows.length]) throw new Error('resume key mismatch');
      rows.push(row);
    }
  }
  const started = Date.now();
  const save = () => writeFileSync(output, JSON.stringify({model:'nsfwjs-mobilenet_v2', backend, resize:'PIL bicubic, whole-image squash, 224 RGB / 255', seconds:(Date.now()-started)/1000, rows}));
  for (let start = rows.length; start < index.keys.length; start += 8) {
    const count = Math.min(8, index.keys.length - start);
    const scores = await page.evaluate(([start, count]) => window.score(start, count), [start, count]);
    for (let i = 0; i < count; i++) {
      const [drawing,hentai,neutral,porn,sexy] = scores.slice(i*5,i*5+5);
      if (![drawing,hentai,neutral,porn,sexy].every(Number.isFinite)) throw new Error('nonfinite model score');
      rows.push({key:index.keys[start+i],label:index.labels[start+i],drawing,hentai,neutral,porn,sexy});
    }
    if (rows.length % 1000 === 0 || rows.length === index.keys.length) {
      save(); console.log(`${rows.length}/${index.keys.length}; ${((Date.now()-started)/1000).toFixed(1)}s`);
    }
  }
} finally {
  await browser?.close(); server.kill();
}

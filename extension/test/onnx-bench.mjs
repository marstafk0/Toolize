// Speed of an ONNX image model in Chromium through onnxruntime-web, per backend.
//   node test/onnx-bench.mjs <model.onnx> [size=256] [--compare=model.onnx] [--runs=25] [--rounds=3] [--webgpu-only]
// Serves the model and onnxruntime-web's files from a throwaway local server, then
// times batches of 1 and 8 on WebGPU and on WASM (the fallback without a usable GPU).
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from './chromium.mjs';

const [modelPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg ?? 256);
const option = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Number(option('runs', 5));
const rounds = Number(option('rounds', 1));
const modelPaths = [modelPath, ...process.argv.filter((value) => value.startsWith('--compare=')).map((value) => value.slice(10))];
const port = Number(process.env.TZ_BENCH_PORT ?? 8791);
if (!modelPath || ![size, runs, rounds, port].every((value) => Number.isInteger(value) && value > 0)) throw new Error('model path and positive integer size/runs/rounds/port required');
const ortDir = join(import.meta.dirname, '../node_modules/onnxruntime-web/dist');
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.html': 'text/html' };
const page = `<!doctype html><script type="module">
import * as ort from '/ort/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
window.bench = async (ep, size, model, runs) => {
  const t0 = performance.now();
  const s = await ort.InferenceSession.create('/model-' + model + '.onnx', { executionProviders: [ep], graphOptimizationLevel: 'all' });
  const load = performance.now() - t0;
  const out = { ep, loadMs: Math.round(load) };
  try {
  for (const b of [1, 2, 4, 8]) {
    const x = new ort.Tensor('float32', new Float32Array(b * 3 * size * size).fill(0.5), [b, 3, size, size]);
    const result = await s.run({ pixels: x });
    const probs = result.probs;
    if (!probs || probs.type !== 'float32' || probs.dims[0] !== b || probs.dims[1] !== 1 ||
        probs.data.length !== b || !Array.from(probs.data).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('invalid probs output');
    }
    out['b' + b + 'probs'] = Array.from(probs.data);
    probs.dispose();
    const run = async () => {
      const result = await s.run({ pixels: x });
      result.probs.dispose();
    };
    for (let warm = 0; warm < 2; warm++) await run();
    const t = performance.now();
    for (let iteration = 0; iteration < runs; iteration++) await run();
    out['b' + b + 'ms'] = Number(((performance.now() - t) / runs).toFixed(3));
  }
  return out;
  } finally {
    await s.release();
  }
};
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file = null;
  if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (/^\/model-\d+\.onnx$/.test(url)) file = modelPaths[Number(url.match(/\d+/)[0])];
  else if (url.startsWith('/ort/')) file = join(ortDir, url.slice(5));
  try {
    statSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1');
const browser = await chromium.launch({ executablePath: findChromium(), headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu'] });
try {
  const p = await browser.newPage();
  p.on('console', (m) => process.env.VERBOSE && console.log('  page:', m.text()));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.waitForFunction(() => window.ready);
  console.log('webgpu adapter:', await p.evaluate(async () => !!(await navigator.gpu?.requestAdapter())));
  const backends = process.argv.includes('--webgpu-only') ? ['webgpu'] : ['webgpu', 'wasm'];
  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < modelPaths.length; offset++) {
      const model = (round + offset) % modelPaths.length;
      for (const ep of backends) {
        const result = await p.evaluate(([ep, size, model, runs]) => window.bench(ep, size, model, runs)
          .catch((error) => ({ ep, error: String(error).slice(0, 500) })), [ep, size, model, runs]);
        console.log(JSON.stringify({ round, model: modelPaths[model], bytes: statSync(modelPaths[model]).size, runs, ...result }));
        if (result.error) process.exitCode = 1;
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

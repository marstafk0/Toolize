// Speed of an ONNX image model in Chromium through onnxruntime-web, per backend.
//   node test/onnx-bench.mjs <model.onnx> [size=256]
// Serves the model and onnxruntime-web's files from a throwaway local server, then
// times batches of 1 and 8 on WebGPU and on WASM (the fallback without a usable GPU).
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from './chromium.mjs';

const [modelPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg ?? 256);
const ortDir = join(import.meta.dirname, '../node_modules/onnxruntime-web/dist');
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.html': 'text/html' };
const page = `<!doctype html><script type="module">
import * as ort from '/ort/ort.webgpu.min.mjs';
ort.env.wasm.wasmPaths = '/ort/';
window.bench = async (ep, size) => {
  const t0 = performance.now();
  const s = await ort.InferenceSession.create('/model.onnx', { executionProviders: [ep] });
  const load = performance.now() - t0;
  const out = { ep, loadMs: Math.round(load) };
  for (const b of [1, 8]) {
    const x = new ort.Tensor('float32', new Float32Array(b * 3 * size * size).fill(0.5), [b, 3, size, size]);
    await s.run({ pixels: x }); // warm
    const n = 5, t = performance.now();
    for (let i = 0; i < n; i++) await s.run({ pixels: x });
    out['b' + b + 'ms'] = Math.round((performance.now() - t) / n);
  }
  return out;
};
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  let file = null;
  if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (url === '/model.onnx') file = modelPath;
  else if (url.startsWith('/ort/')) file = join(ortDir, url.slice(5));
  try {
    statSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(8791);
const browser = await chromium.launch({ executablePath: findChromium(), headless: !process.env.HEADED, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
try {
  const p = await browser.newPage();
  p.on('console', (m) => process.env.VERBOSE && console.log('  page:', m.text()));
  await p.goto('http://127.0.0.1:8791/');
  await p.waitForFunction(() => window.ready);
  console.log('webgpu adapter:', await p.evaluate(async () => !!(await navigator.gpu?.requestAdapter())));
  for (const ep of ['webgpu', 'wasm']) {
    console.log(JSON.stringify(await p.evaluate(([ep, size]) => window.bench(ep, size).catch((e) => ({ ep, error: String(e).slice(0, 200) })), [ep, size])));
  }
} finally {
  await browser.close();
  server.close();
}

// Numeric-only audit of SAFE YouTube thumbnails. Uses the production decoder,
// cropper and classifier inside an isolated extension origin. No images displayed.
// node test/safety-audit.mjs [output-dir] [webgpu|wasm]
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = resolve(import.meta.dirname, '..');
const src = resolve(process.env.SAFETY_CORPUS ?? join(root, 'test/corpus/safe/youtube-thumbs'));
const out = resolve(process.argv[2] ?? join(root, 'test/.artifacts/safety-audit'));
const ep = process.argv[3] ?? 'webgpu';
if (!['webgpu', 'wasm'].includes(ep)) throw new Error('unknown backend');
mkdirSync(out, { recursive: true });
const dist = isolatedDist(join(root, 'dist'));
if (process.env.SAFETY_MODEL) copyFileSync(resolve(process.env.SAFETY_MODEL), join(dist, 'models/safety/safety.onnx'));
const profile = mkdtempSync(join(tmpdir(), 'tz-safety-audit-'));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const allowed = new Set(manifest.map((m) => m.file));
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const url = new URL(req.url, 'http://localhost');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (req.method === 'POST' && name.endsWith('.f32') && allowed.has(name.slice(0, -4))) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    writeFileSync(join(out, name), Buffer.concat(chunks));
    return res.end('ok');
  }
  if (allowed.has(name)) return res.end(readFileSync(join(src, name)));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await build({
  stdin: { contents: `
import * as ort from 'onnxruntime-web/webgpu';
import { SafetyClassifier } from './src/offscreen/safety-classifier';
import { fetchImageBlob, decodeBlob, cropToImageData } from './src/offscreen/image-loader';
window.audit = async (manifest, base, ep) => {
  const safety = new SafetyClassifier(chrome.runtime.getURL('models/safety/safety.onnx'), chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.wasm'));
  // This diagnostic forces private bucket shapes, bypassing classifyBatch's
  // lastUse bookkeeping. Disable idle warming so it cannot overlap forced runs.
  // The separate corpus runner retains normal production warm-up/scheduling.
  safety.warmRest = async () => {};
  if (ep === 'webgpu') await safety.load();
  else {
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.wasm')};
    safety.session = await ort.InferenceSession.create(safety.modelUrl, {executionProviders:['wasm'], graphOptimizationLevel:'all'});
    await safety.warm(1); safety.ready = true;
  }
  if (!safety.ready) throw new Error(safety.error);
  const info = ep === 'webgpu' ? (await navigator.gpu.requestAdapter()).info : null;
  const images = [], rows = [], decodeChecks = [];
  for (const meta of manifest) {
    const blob = await fetchImageBlob(base + '/' + meta.file);
    const d = await decodeBlob(blob);
    const image = cropToImageData(d, {x:0,y:0,w:d.width,h:d.height},224);
    images.push(image);
    if (decodeChecks.length < 16) {
      const bmp = await createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
      const alt = cropToImageData({source:bmp}, {x:0,y:0,w:bmp.width,h:bmp.height},224);
      let maxDiff=0, minAlpha=255;
      for(let p=0;p<image.data.length;p++) {
        maxDiff=Math.max(maxDiff,Math.abs(image.data[p]-alt.data[p]));
        if(p%4===3) minAlpha=Math.min(minAlpha,image.data[p]);
      }
      decodeChecks.push({file:meta.file,colorSpace:image.colorSpace,minAlpha,maxDiff});
      bmp.close();
    }
    d.close();
  }
  for(let i=0; i<images.length; i+=8) {
    const batch = images.slice(i,i+8);
    const scores = await safety.runBucket(batch, 8);
    for(let j=0;j<batch.length;j++) {
      const single = (await safety.runBucket([batch[j]],1))[0];
      const padded = ep === 'webgpu' ? (await safety.runBucket([batch[j]],8))[0] : undefined;
      rows.push({file:manifest[i+j].file, single, mixed:scores[j], padded});
      if(ep === 'webgpu') {
        const data = new Float32Array(3*224*224), px=batch[j].data, plane=224*224;
        for(let p=0;p<plane;p++) for(let c=0;c<3;c++) data[c*plane+p]=px[4*p+c]/255;
        await fetch(base+'/'+manifest[i+j].file+'.f32', {method:'POST', body:data});
      }
    }
    console.log('audit',ep,Math.min(i+8,images.length),images.length);
  }
  return {ep, info:info ? {vendor:info.vendor,architecture:info.architecture,description:info.description}:null, rows, decodeChecks};
};
`, resolveDir: root, loader: 'js' },
  outfile: join(dist, 'safety-audit.js'), bundle: true, format: 'esm', define: { __DEV__: 'true' }, logLevel: 'silent',
});
writeFileSync(join(dist, 'safety-audit.html'), '<!doctype html><script type="module" src="safety-audit.js"></script>');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(), headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...(ep === 'wasm' ? ['--disable-gpu'] : ['--enable-unsafe-webgpu'])],
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('console', (m) => { if (m.text().startsWith('audit ')) console.log(m.text()); });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/safety-audit.html`);
  await page.waitForFunction(() => !!window.audit);
  const result = await page.evaluate(([manifest, base, ep]) => window.audit(manifest,base,ep), [manifest, base, ep]);
  writeFileSync(join(out, ep+'.json'), JSON.stringify(result, null, 2));
  console.log(ep, 'FP single/mixed/padded', ...['single','mixed','padded'].map((k)=> result.rows.every((r)=>r[k]===undefined) ? 'n/a' : result.rows.filter((r)=>r[k]>0.5).length), '/',result.rows.length, result.info);
  if (result.rows.some((r) => !Number.isFinite(r.single) || !Number.isFinite(r.mixed) || (r.padded !== undefined && !Number.isFinite(r.padded)))) {
    throw new Error('non-finite safety probability (see saved report)');
  }
  if (result.rows.some((r) => Math.abs(r.single-r.mixed) > 0.02 || (r.padded !== undefined && Math.abs(r.single-r.padded) > 0.02))) {
    throw new Error('batch-dependent safety score (see saved report)');
  }
} finally {
  await context?.close();
  server.close();
  // Only remove this harness's own fresh temp directories.
  for(const [p,prefix] of [[dist,'tz-dist-'],[profile,'tz-safety-audit-']]) {
    if(dirname(p)!==resolve(tmpdir()) || !basename(p).startsWith(prefix)) throw new Error('unexpected temporary directory');
    rmSync(p,{recursive:true,force:true});
  }
}

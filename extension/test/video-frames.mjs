import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import * as esbuild from 'esbuild';
import { findChromium } from './chromium.mjs';

const work = resolve(process.argv[2] ?? '../tools/safety-model/work/video-frames');
const videos = JSON.parse(readFileSync(join(work, 'videos.json'), 'utf8')).filter((row) => row.downloaded);
const allowed = new Map(videos.map((row) => [`/${row.id}.mp4`, row.file]));
const modelRoot = resolve(import.meta.dirname, '../dist/models/mobilenet_v2');
const modelManifest = JSON.parse(readFileSync(join(modelRoot, 'model.json'), 'utf8'));
const modelFiles = new Set(['model.json', ...modelManifest.weightsManifest.flatMap((row) => row.paths)]);
mkdirSync(join(work, 'safe/video-frames'), { recursive: true });
const server = createServer((req, res) => {
  if (req.url.startsWith('/models/') && modelFiles.has(req.url.slice(8))) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(readFileSync(join(modelRoot, req.url.slice(8))));
    return;
  }
  if (req.url === '/') { res.end('<!doctype html><html><body></body></html>'); return; }
  const file = allowed.get(req.url);
  if (!file) { res.writeHead(404).end(); return; }
  const size = statSync(file).size;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
    'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const framesFile = join(work, 'frames.json');
const frames = existsSync(framesFile) ? JSON.parse(readFileSync(framesFile, 'utf8')) : [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.goto(base);
  const bundle = await esbuild.build({
    stdin: { contents: `import * as tf from '@tensorflow/tfjs';
      window.loadFrameClassifier = async () => {
        tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true);
        if (!await tf.setBackend('webgl')) throw new Error('hardware WebGL unavailable');
        await tf.ready(); tf.enableProdMode();
        const model = await tf.loadLayersModel('${base}/models/model.json');
        window.scoreFrame = (image) => {
          const output = tf.tidy(() => model.predict(tf.div(tf.cast(tf.browser.fromPixels(image, 3).expandDims(), 'float32'), 255)));
          const [drawing, hentai, neutral, porn, sexy] = output.dataSync(); output.dispose();
          return { drawing, hentai, neutral, porn, sexy };
        };
      };`, resolveDir: resolve(import.meta.dirname, '..') },
    bundle: true, format: 'iife', write: false, logLevel: 'silent',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.loadFrameClassifier());
  for (const row of videos) {
    const previous = frames.filter((frame) => frame.id === row.id).length;
    if (previous === 10) continue;
    if (previous) throw new Error(`incomplete prior video: ${row.id}`);
    try {
      await page.setContent(`<video muted preload="auto" crossorigin="anonymous" src="${base}/${row.id}.mp4"></video>`);
      await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 30_000 });
      for (let index = 0; index < 10; index++) {
        const key = `safe/video-frames/${row.id}--${String(index).padStart(2, '0')}.jpg`;
        const pixels = key.replace('.jpg', '.f32');
        const result = await page.evaluate(async ({ index }) => {
          const video = document.querySelector('video');
          const at = Math.min(video.duration - 0.05, Math.max(0.05, video.duration * (index + 0.5) / 10));
          await new Promise((done, fail) => {
            video.addEventListener('seeked', done, { once: true });
            video.addEventListener('error', fail, { once: true });
            video.currentTime = at;
          });
          const scale = Math.min(1, 448 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          const jpeg = canvas.toDataURL('image/jpeg', 0.85);
          const bitmap = await createImageBitmap(await (await fetch(jpeg)).blob());
          const resized = new OffscreenCanvas(224, 224);
          const context = resized.getContext('2d', { willReadFrequently: true });
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, 224, 224);
          bitmap.close();
          const image = context.getImageData(0, 0, 224, 224);
          const scores = window.scoreFrame(image);
          const rgba = image.data;
          const tensor = new Float32Array(3 * 224 * 224);
          for (let pixel = 0; pixel < 224 * 224; pixel++) for (let channel = 0; channel < 3; channel++) {
            tensor[channel * 224 * 224 + pixel] = rgba[pixel * 4 + channel] / 255;
          }
          let binary = '';
          const bytes = new Uint8Array(tensor.buffer);
          for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          return { jpeg: jpeg.split(',')[1], pixels: btoa(binary), scores, at, width: canvas.width, height: canvas.height };
        }, { index });
        writeFileSync(join(work, key), Buffer.from(result.jpeg, 'base64'));
        writeFileSync(join(work, pixels), Buffer.from(result.pixels, 'base64'));
        frames.push({ key, pixels, id: row.id, channel: row.channel, handle: row.handle, category: row.category,
          split: row.split, at: result.at, width: result.width, height: result.height, whole: result.scores });
      }
      console.log(JSON.stringify({ video: row.id, channel: row.handle, split: row.split, frames: 10 }));
    } catch (error) {
      errors.push({ id: row.id, error: error.message });
      console.log(JSON.stringify({ video: row.id, error: error.message }));
    }
    writeFileSync(framesFile, JSON.stringify(frames, null, 2));
    writeFileSync(join(work, 'frame-errors.json'), JSON.stringify(errors, null, 2));
  }
  console.log(JSON.stringify({ videos: videos.length, frames: frames.length, errors: errors.length }));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

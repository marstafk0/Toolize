// Real playback, real models, numeric diagnostics only. No screenshots or frame files.
// node build.mjs --dev
// node test/video-trace.mjs before
// node test/video-trace.mjs after --replay=test/.artifacts/video-trace/before.json
// node test/video-trace.mjs --summarize=test/.artifacts/video-trace/before.json
// --direct skips YouTube; --seconds=60 and --limit=12 are the defaults.
// --dist=<built extension> and --direct-offset=1 allow extra baseline clips.
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const option = (name, fallback) => process.argv.find((s) => s.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const label = process.argv[2]?.startsWith('--') ? 'trace' : process.argv[2] ?? 'trace';
if (!/^[\w-]+$/.test(label)) throw new Error('label must be a simple filename');
const seconds = Number(option('seconds', 60));
const limit = Number(option('limit', 12));
const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'test/.artifacts/video-trace');
const media = join(artifacts, 'media');
mkdirSync(media, { recursive: true });
const replay = option('replay');
const previous = replay ? JSON.parse(readFileSync(resolve(replay), 'utf8')) : null;
const youtube = [
  ['music', 'dTAAsCNK7RA'], // OK Go: Here It Goes Again
  ['cooking', 'hFZFjoX2cGg'], // Gordon Ramsay: scrambled eggs
  ['vlog', 'jNQXAC9IVRw'], // Me at the zoo
  ['gaming', 'MmB9b5njVbA'], // Minecraft trailer
  ['news', 'M8GgNUOoQX8'], // BBC: children interrupt interview
  ['nature', 'LXb3EKWsInQ'], // Costa Rica in 4K
  ['music', 'fJ9rUzIMcZQ'], // Queen: Bohemian Rhapsody
  ['animation', 'aqz-KE-bpKQ'], // Big Buck Bunny
  ['animation', 'YE7VzlLtp-4'], // Sintel
  ['talk', 'UF8uR6Z6KLc'], // Stanford commencement
  ['vlog', 'jNQXAC9IVRw', true],
  ['animation', 'aqz-KE-bpKQ', true],
].map(([category, id, short]) => ({ category, url: `https://www.youtube.com/${short ? `shorts/${id}` : `watch?v=${id}`}` }));
// Public nature clips and Blender open movies. Keep several hosts: sample buckets
// sometimes stop allowing anonymous requests (record failures and try the next).
const direct = [
  { name: 'Flowers', category: 'nature', url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
  { name: 'Bears', category: 'wildlife', url: 'https://www.w3schools.com/html/movie.mp4' },
  { name: 'Bunny-short', category: 'animation', url: 'https://www.w3schools.com/html/mov_bbb.mp4' },
  { name: 'Sintel-trailer', category: 'animation', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4' },
  ...[
    ['Jellyfish', 'jellyfish', 'Jellyfish'], ['Bunny-demo', 'bigbuckbunny', 'Big_Buck_Bunny'], ['Sintel-demo', 'sintel', 'Sintel'],
  ].map(([name, directory, file]) => ({ name, category: 'public sample', url: `https://test-videos.co.uk/vids/${directory}/mp4/h264/720/${file}_720_10s_1MB.mp4` })),
  { name: 'Bunny-trailer', category: 'animation', url: 'https://media.w3.org/2010/05/bunny/trailer.mp4' },
  { name: 'Sintel-low-bitrate', category: 'animation', url: 'https://media.w3.org/2010/05/video/movie_300.mp4' },
  // Alternate encodings exercise playback routes if YouTube is wholly unavailable;
  // these are revisits of the same ordinary films, not additional distinct content.
  ...[
    ['Jellyfish-360', 'jellyfish', 'Jellyfish'], ['Bunny-360', 'bigbuckbunny', 'Big_Buck_Bunny'], ['Sintel-360', 'sintel', 'Sintel'],
  ].map(([name, directory, file]) => ({ name, category: 'public sample', url: `https://test-videos.co.uk/vids/${directory}/mp4/h264/360/${file}_360_10s_1MB.mp4` })),
];

function summarize(report) {
  const ruleOf = (v) => v.frameInfo?.obvious ? 'obvious single frame' :
    (v.frameInfo?.window.filter((f) => f === 'flagged').length ?? 0) >= 2 ? '2-of-3' : 'unshown doubtful';
  const transitions = report.videos.flatMap((v) => v.verdicts.filter((r) => r.decision === 'blocked'));
  for (const video of report.videos) {
    video.rules = [...new Set(video.verdicts.filter((r) => r.decision === 'blocked').map(ruleOf))];
    let shown = false;
    video.midWatchTransitions = 0;
    for (const verdict of [...video.verdicts].sort((a, b) => a.at - b.at)) {
      if (verdict.decision === 'clean') shown = true;
      else if (shown) video.midWatchTransitions++;
    }
  }
  const frames = report.videos.flatMap((v) => v.samples);
  const scores = frames.map((s) => s.safety).filter((s) => s !== undefined).sort((a, b) => a - b);
  const quantile = (p) => scores[Math.min(scores.length - 1, Math.floor((scores.length - 1) * p))];
  return {
    videos: report.videos.length, blurred: report.videos.filter((v) => v.blurred).length, frames: frames.length,
    shownThenBlurred: report.videos.filter((v) => v.midWatchTransitions > 0).length,
    midWatchTransitions: report.videos.reduce((n, v) => n + v.midWatchTransitions, 0),
    rules: Object.fromEntries(['obvious single frame', '2-of-3', 'unshown doubtful'].map((rule) => [rule, {
      videos: report.videos.filter((v) => v.rules.includes(rule)).length,
      transitions: transitions.filter((r) => ruleOf(r) === rule).length,
    }])),
    safety: { n: scores.length, min: scores[0], median: quantile(0.5), p90: quantile(0.9), p95: quantile(0.95), max: scores.at(-1),
      bins: Object.fromEntries([[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 0.97], [0.97, 1.01]].map(([lo, hi]) => [`${lo}-${Math.min(hi, 1)}`, scores.filter((s) => s >= lo && s < hi).length])),
      highSafetyNeutral: frames.filter((s) => s.safety >= 0.9 && s.neutral >= 0.9).length },
  };
}
if (option('summarize')) {
  const file = resolve(option('summarize'));
  const report = JSON.parse(readFileSync(file, 'utf8'));
  report.summary = summarize(report);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  process.exit(0);
}

async function download(item) {
  const path = join(media, `${item.name}.mp4`);
  if (!existsSync(path)) {
    console.log(`Downloading ordinary sample ${item.name}`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`download ${item.name}: HTTP ${response.status}`);
    const part = `${path}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      renameSync(part, path);
    } catch (e) { rmSync(part, { force: true }); throw e; }
  }
  return path;
}

// A test-owned server with range support, so local files exercise live canvas frames
// rather than the offscreen whole-file fallback. Only the allowlisted samples exist.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const item = direct.find((v) => path === `/media/${v.name}.mp4`);
  if (item) {
    const file = join(media, `${item.name}.mp4`);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    const size = statSync(file).size;
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(match ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Ordinary public video trace</title><style>body{margin:0;background:#eee}video{width:960px;height:540px}</style>');
  }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(Number(process.env.TZ_TRACE_PORT ?? 18479), '127.0.0.1', yes); });
const base = `http://127.0.0.1:${server.address().port}`;
const dist = isolatedDist(resolve(option('dist', join(root, 'dist'))));
const profile = mkdtempSync(join(tmpdir(), 'tz-video-trace-'));
let context;
const report = { label, seconds, started: new Date().toISOString(), engine: null, videos: [], attempts: [] };
const save = () => writeFileSync(join(artifacts, `${label}.json`), JSON.stringify(report, null, 2));
const wait = (ms) => new Promise((yes) => setTimeout(yes, ms));
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(), headless: !process.env.HEADED, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, enabled: true, preset: 'balanced', mode: 'safe', feeds: {}, trustedChannels: [], allowLiveStreams: false } });
  });
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    report.engine = await sw.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', kind: 'engineInfo' })).catch(() => null);
    if (report.engine?.ready && report.engine.safety !== 'loading') break;
    await wait(500);
  }
  console.log('Engine:', JSON.stringify(report.engine));
  if (!report.engine?.ready || report.engine.safety !== 'webgpu') throw new Error('trace requires the real WebGPU safety model');

  async function trace(item, local = false) {
    const page = await context.newPage();
    const row = { ...item, local, samples: [], verdicts: [], playback: [], resumed: 0 };
    page.on('console', (msg) => {
      const prefix = '[toolize:video-frame] ';
      if (msg.text().startsWith(prefix)) row.samples.push(JSON.parse(msg.text().slice(prefix.length)));
    });
    try {
      if (local) await download(item);
      await page.goto(local ? base : item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (local) {
        await page.evaluate((src) => {
          const v = document.createElement('video');
          Object.assign(v, { src, muted: true, loop: true, autoplay: true, controls: true });
          document.body.append(v);
          v.play().catch(() => {});
        }, `${base}/media/${item.name}.mp4`);
      } else {
        // YouTube/Google consent, without signing in or accepting optional cookies.
        for (const name of ['Reject all', 'Accept all', 'I agree']) {
          const button = page.getByRole('button', { name, exact: true }).first();
          if (await button.isVisible().catch(() => false)) { await button.click(); break; }
        }
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) { v.muted = true; v.loop = true; v.play().catch(() => {}); }
        });
      }
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.readyState >= 2 && v.currentTime > 0), null, { timeout: 25_000 });
      const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, page.url());
      if (tabId === undefined) throw new Error('could not find playback tab');
      const seen = new Set();
      const started = Date.now();
      console.log(`Tracing ${item.name ?? item.url} for ${seconds}s`);
      for (const end = started + seconds * 1000; Date.now() < end;) {
        const rows = await sw.evaluate(async (id) => (await chrome.storage.session.get('tabVerdicts')).tabVerdicts?.[id] ?? [], tabId);
        for (const verdict of rows.filter((r) => r.kind === 'video')) {
          const key = JSON.stringify(verdict);
          if (!seen.has(key)) { seen.add(key); row.verdicts.push(verdict); }
        }
        row.playback.push(await page.evaluate(() => {
          const v = document.querySelector('video');
          const state = v ? { t: Date.now(), at: v.currentTime, paused: v.paused, state: v.getAttribute('data-tz') } : { missing: true };
          // Ordinary allowlisted clips only: resume after a model-triggered pause to
          // collect the rest of the minute, recording that intervention explicitly.
          if (v?.paused && !v.ended) v.play().catch(() => {});
          return state;
        }));
        if (row.playback.at(-1).paused) row.resumed++;
        await wait(500);
      }
      await wait(1200); // flush the last verdict batch
      const tail = await sw.evaluate(async (id) => (await chrome.storage.session.get('tabVerdicts')).tabVerdicts?.[id] ?? [], tabId);
      for (const verdict of tail.filter((r) => r.kind === 'video')) if (!seen.has(JSON.stringify(verdict))) row.verdicts.push(verdict);
      if (!row.samples.length) throw new Error('no per-frame diagnostics: build with --dev');
      row.elapsedMs = Date.now() - started;
      row.blurred = row.samples.some((s) => s.verdict === 'blocked');
      // Count triggering transitions, not subsequent clean samples while the video
      // waits for its reveal streak. Popup entries preserve the actual trigger.
      row.rules = [...new Set(row.verdicts.filter((v) => v.decision === 'blocked').map((v) =>
        v.frameInfo?.obvious ? 'obvious single frame' : v.frameInfo?.window.filter((f) => f === 'flagged').length >= 2 ? '2-of-3' : 'unshown doubtful'))];
      report.videos.push(row);
      console.log(JSON.stringify({ video: item.name ?? item.url, frames: row.samples.length, blurred: row.blurred, rules: row.rules }));
      save();
      return true;
    } catch (e) {
      const error = page.locator('.ytp-error-content-wrap, #error-screen').first();
      const reason = await error.count() ? await error.innerText().catch(() => '') : '';
      report.attempts.push({ ...item, error: e.message, reason: reason.slice(0, 500) });
      console.log(`Unavailable ${item.name ?? item.url}: ${reason || e.message}`);
      save();
      return false;
    } finally { await page.close(); }
  }

  if (previous) {
    for (const item of previous.videos.slice(0, limit)) await trace({ category: item.category, url: item.url, ...(item.name ? { name: item.name } : {}) }, item.local);
  } else {
    if (!process.argv.includes('--direct')) {
      let consecutiveFailures = 0;
      for (const item of youtube.slice(0, limit)) {
        const ok = await trace(item);
        consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= 2) { console.log('YouTube refused playback twice; switching to public MP4s.'); break; }
      }
    }
    for (const item of direct.slice(Number(option('direct-offset', 0)))) {
      if (report.videos.length >= limit) break;
      await trace(item, true);
    }
  }
  report.summary = summarize(report);
  console.log('SUMMARY', JSON.stringify(report.summary));
  if (report.videos.length < limit) throw new Error(`only traced ${report.videos.length}/${limit} videos`);
} finally {
  save();
  await context?.close();
  await new Promise((yes) => server.close(yes));
  for (const [path, prefix] of [[profile, 'tz-video-trace-'], [dist, 'tz-dist-']]) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith(prefix)) throw new Error(`unexpected temporary path: ${path}`);
    rmSync(path, { recursive: true, force: true });
  }
}

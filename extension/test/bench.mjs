// Classification throughput benchmark.
//
//   npm run bench                     150 photo-sized images on a local page
//   NO_GPU=1 npm run bench            same, on the WASM backend
//   npm run bench -- <url>            a real page (e.g. a YouTube search), scrolled once
//
// Reports wall time until every image near the viewport is decided, and where the
// offscreen pipeline spent its time (fetch / decode / crop / inference wait), so a
// change to the pipeline can be judged by numbers rather than feel.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = isolatedDist(join(root, 'dist'));
const url = process.argv[2];
const COUNT = Number(process.env.COUNT ?? 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = url ? null : spawn(process.execPath, [join(root, 'scripts/serve-test.mjs')], { stdio: 'ignore' });
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tz-bench-')), {
  executablePath: findChromium(),
  headless: !process.env.HEADED,
  viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...(process.env.NO_GPU ? ['--disable-gpu'] : [])],
});
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ settings: { enabled: true, preset: 'balanced', mode: 'safe', blockAdultSites: true } });
  });
  const info = () => sw.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', kind: 'engineInfo' })).catch(() => null);
  // Wait for the model AND every warm-up bucket, so the run measures steady state.
  for (let i = 0; i < 240; i++) {
    const e = await info();
    if (e?.ready && !e.warming) break;
    await sleep(250);
  }
  const before = await info();
  console.log(`backend ${before.backend}, model load ${before.loadMs} ms`);

  const page = await context.newPage();
  // Blur time per image: from its load event to its verdict. That is what a user sees.
  await page.addInitScript(() => {
    const loaded = new WeakMap();
    window.__blurMs = [];
    document.addEventListener('load', (e) => {
      if (e.target.localName === 'img' && !loaded.has(e.target)) loaded.set(e.target, performance.now());
    }, true);
    new MutationObserver((rs) => {
      for (const r of rs) {
        const el = r.target;
        const at = loaded.get(el);
        if (at !== undefined && ['clean', 'blocked'].includes(el.getAttribute('data-tz'))) {
          window.__blurMs.push(performance.now() - at);
          loaded.delete(el);
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-tz'] });
  });
  // Decided = anything but pending/absent. Counted only for images large enough to classify.
  const tally = () =>
    page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => {
        const r = i.getBoundingClientRect();
        // On screen (carousels park images off to the side; those wait until scrolled in).
        return r.width >= 48 && r.height >= 48 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
          && (i.currentSrc || i.src);
      });
      const pending = imgs.filter((i) => !['clean', 'blocked', 'skip', 'error', 'off'].includes(i.getAttribute('data-tz'))).length;
      return { total: imgs.length, pending };
    });

  // The test server encodes each PNG on first request; do that now so the run times the
  // extension, not the server. The browser has never seen these URLs.
  const stamp = Date.now();
  const srcs = Array.from({ length: COUNT }, (_, i) => `/img/1280x720/bench-${stamp}-${i}.png`);
  if (!url) {
    await sleep(300);
    await Promise.all(srcs.map((s) => fetch(`http://localhost:8787${s}`).then((r) => r.arrayBuffer())));
  }

  const timing = { queue: [], rtt: [] };
  page.on('console', (m) => {
    const x = m.text().match(/\[toolize-timing\] queue (\d+) rtt (\d+)/);
    if (x) { timing.queue.push(+x[1]); timing.rtt.push(+x[2]); }
  });
  const t0 = Date.now();
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto('http://localhost:8787/pages/frame.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate((srcs) => {
      document.body.innerHTML = '';
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(10,130px);gap:4px';
      for (const src of srcs) {
        const img = document.createElement('img');
        img.width = 130;
        img.height = 73;
        img.src = src;
        grid.append(img);
      }
      document.body.append(grid);
    }, srcs);
  }

  let last = { total: 0, pending: 0 };
  let firstDone = 0;
  for (let i = 0; i < 600; i++) {
    last = await tally();
    if (last.total > 0 && last.pending === 0) {
      firstDone = Date.now() - t0;
      break;
    }
    await sleep(100);
  }
  const after = await info();
  console.log(`decided ${last.total - last.pending}/${last.total} images in ${firstDone || 'TIMEOUT'} ms` +
    (firstDone ? ` (${((last.total / firstDone) * 1000).toFixed(1)} img/s)` : ''));
  const blur = (await page.evaluate(() => window.__blurMs)).sort((a, b) => a - b);
  const pct = (p) => Math.round(blur[Math.min(blur.length - 1, Math.floor(blur.length * p))] ?? 0);
  console.log(`blur after load: median ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${pct(1)} ms (${blur.length} images)`);
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  console.log(`page side: median queue wait ${med(timing.queue)} ms, median round trip ${med(timing.rtt)} ms`);
  console.log('pipeline', JSON.stringify(after.perf));
  if (last.pending && process.env.STUCK) {
    const stuck = await page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width >= 48 && r.height >= 48 && r.top < innerHeight + 1200 && (i.currentSrc || i.src)
            && !['clean', 'blocked', 'skip', 'error', 'off'].includes(i.getAttribute('data-tz'));
        })
        .slice(0, 12)
        .map((i) => {
          const r = i.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = cy > 0 && cy < innerHeight && cx > 0 && cx < innerWidth ? document.elementFromPoint(cx, cy) : null; return { onScreen: hit === i, left: Math.round(r.left), hitTag: hit?.localName, tz: i.getAttribute('data-tz'), src: (i.currentSrc || i.src).slice(0, 50), attr: (i.getAttribute('src') || '').slice(0, 40),
            complete: i.complete, nw: i.naturalWidth, nh: i.naturalHeight, top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
            vis: getComputedStyle(i).visibility, op: getComputedStyle(i).opacity, loading: i.loading };
        }));
    for (const s of stuck) console.log('  stuck', JSON.stringify(s));
  }
} finally {
  await context.close();
  server?.kill();
}

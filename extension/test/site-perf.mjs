// What the extension costs on real sites: the same pages with and without it.
//   node test/site-perf.mjs [runs]        (production build in dist/ for fair numbers)
// Reddit: page load, then 8 s of scrolling — frame gaps and main-thread long tasks.
// YouTube: open a watch page, then click a recommended video — time until it plays.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const runs = Number(process.argv[2] ?? 2);
const ext = isolatedDist(join(import.meta.dirname, '../dist'));

const LONG_TASKS = `(() => {
  window.__tzLong = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__tzLong.push(e.duration); })
    .observe({ type: 'longtask', buffered: true });
})();`;

function summary(gaps) {
  const s = [...gaps].sort((a, b) => a - b);
  const jank = gaps.filter((g) => g > 50).length;
  return `frames ${s.length}, p95 ${s[Math.floor(s.length * 0.95)]?.toFixed(0)} ms, max ${s.at(-1)?.toFixed(0)} ms, >50ms ${jank}`;
}

async function launch(withExt) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tz-perf-')), {
    executablePath: findChromium(), headless: !process.env.HEADED, viewport: { width: 1280, height: 900 },
    args: withExt
      ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required']
      : ['--autoplay-policy=no-user-gesture-required'],
  });
  await ctx.addInitScript(LONG_TASKS);
  if (withExt) {
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    await new Promise((r) => setTimeout(r, 4000)); // classifier warm-up
  }
  return ctx;
}

async function reddit(ctx) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(process.env.REDDIT ?? 'https://www.reddit.com/r/pics/', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  const load = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 2000));
  const gaps = await page.evaluate(() => new Promise((resolve) => {
    const gaps = [];
    let last = performance.now();
    const end = last + 8000;
    const step = (t) => {
      gaps.push(t - last);
      last = t;
      window.scrollBy(0, 40);
      if (t < end) requestAnimationFrame(step);
      else resolve(gaps);
    };
    requestAnimationFrame(step);
  }));
  const long = await page.evaluate(() => window.__tzLong);
  const tz = await page.evaluate(() => [...document.querySelectorAll('img,video')].reduce((m, e) => {
    const k = e.getAttribute('data-tz') ?? 'none';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {}));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.close();
  return `load ${load} ms; ${summary(gaps)}; long tasks ${long.length} (${long.reduce((a, b) => a + b, 0).toFixed(0)} ms); ${JSON.stringify(tz)}`;
}

async function youtube(ctx) {
  const page = await ctx.newPage();
  const playing = () => page.waitForFunction(() => {
    const v = document.querySelector('#movie_player video');
    return v && v.currentTime > 0.1 && !v.paused;
  }, null, { timeout: 30_000, polling: 50 });
  let t0 = Date.now();
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const cold = await playing().then(() => `${Date.now() - t0} ms`, () => 'never');
  await new Promise((r) => setTimeout(r, 3000));
  const link = page.locator('ytd-watch-next-secondary-results-renderer a[href^="/watch"]').first();
  await link.waitFor({ timeout: 20_000 }).catch(() => {});
  const href = await link.getAttribute('href').catch(() => null);
  let click = 'no related video found';
  if (href) {
    const id = new URL(href, 'https://x').searchParams.get('v');
    // Played = a 'timeupdate' past 0.1 s after the URL has changed to the new video.
    await page.evaluate(() => {
      window.__tzPlayedAt = 0;
      document.addEventListener('timeupdate', (e) => {
        const v = e.target;
        if (!window.__tzPlayedAt && v.closest?.('#movie_player') && v.currentTime > 0.1 && !location.href.includes(window.__tzOld)) window.__tzPlayedAt = performance.now();
      }, true);
      window.__tzOld = new URLSearchParams(location.search).get('v');
    });
    const start = await page.evaluate(() => performance.now());
    await link.click();
    click = await page.waitForFunction((id) => location.href.includes(id) && window.__tzPlayedAt > 0, id, { timeout: 30_000, polling: 50 })
      .then(() => page.evaluate((start) => `${(window.__tzPlayedAt - start).toFixed(0)} ms`, start), () => 'never');
    // Seen = playing and not blurred (safe reveal), or no verdict at all without the extension.
    click += '; →visible ' + await page.waitForFunction(() => {
      const v = document.querySelector('#movie_player video');
      const tz = v?.getAttribute('data-tz');
      return !tz || tz === 'clean' || tz === 'skip';
    }, null, { timeout: 30_000, polling: 20 }).then(() => page.evaluate((start) => `${(performance.now() - start).toFixed(0)} ms (${document.querySelector('#movie_player video')?.getAttribute('data-tz') ?? 'none'})`, start), () => 'never');
  }
  const long = await page.evaluate(() => window.__tzLong);
  await page.close();
  return `cold watch→playing ${cold}; click related→playing ${click}; long tasks ${long.length} (${long.reduce((a, b) => a + b, 0).toFixed(0)} ms)`;
}

for (let i = 0; i < runs; i++) {
  for (const withExt of [false, true]) {
    const ctx = await launch(withExt);
    try {
      const label = withExt ? 'with extension' : 'without      ';
      if (!process.env.NO_REDDIT) console.log(`[${i + 1}] ${label} reddit:  ${await reddit(ctx).catch((e) => e.message.slice(0, 120))}`);
      console.log(`[${i + 1}] ${label} youtube: ${await youtube(ctx).catch((e) => e.message.slice(0, 120))}`);
    } finally {
      await ctx.close();
    }
  }
}

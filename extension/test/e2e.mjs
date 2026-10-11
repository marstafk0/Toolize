// End-to-end test: loads the dev build into Chromium, drives test/pages/index.html,
// and asserts every image ends in its expected state. Also checks no-flash, src swaps,
// settings changes, and scroll smoothness under classification load.
//
//   npm run test:e2e              (headless)
//   HEADED=1 npm run test:e2e     (watch it)
//   NO_GPU=1 npm run test:e2e     (GPU-less machine: exercises the WASM backend)
//   CHROMIUM=/path/to/chrome      (override browser; branded Chrome ignores --load-extension)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = isolatedDist(join(root, 'dist'));
const artifacts = join(root, 'test/.artifacts');
const BASE = 'http://localhost:8787';
mkdirSync(artifacts, { recursive: true });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function waitFor(fn, { timeout = 30_000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const server = spawn(process.execPath, [join(root, 'scripts/serve-test.mjs')], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
let context;
try {
  await new Promise((r) => setTimeout(r, 500));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    // NO_GPU=1 forces the software-GL path -> classifier should pick the WASM backend.
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...(process.env.NO_GPU ? ['--disable-gpu'] : [])],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const setSettings = (patch) =>
    sw.evaluate(async (p) => {
      const cur = (await chrome.storage.local.get('settings')).settings ?? {};
      await chrome.storage.local.set({ settings: { ...cur, ...p } });
    }, patch);
  await setSettings({ enabled: true, preset: 'balanced', mode: 'safe' });

  const tBoot = Date.now();
  const engineInfo = () =>
    sw.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', kind: 'engineInfo' })).catch(() => null);
  const booted = await waitFor(async () => (await engineInfo())?.ready && (await engineInfo()));
  check('model cold start', !!booted, booted ? `load+warm-up ${booted.loadMs} ms (${booted.backend}), ready after ${Date.now() - tBoot} ms` : '');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.VERBOSE) page.on('console', (m) => m.text().includes('[toolize]') && console.log('    PAGE', m.text()));
  const t0 = Date.now();
  await page.goto(`${BASE}/pages/index.html`, { waitUntil: 'domcontentloaded' });

  // ---- no flash: freshly inserted images are blurred synchronously
  const flash = await page.evaluate(() => window.__bbFlashChecks());
  for (const [k, v] of Object.entries(flash)) check(`no-flash: ${k} blurred on insertion`, /blur/.test(v), v);

  // ---- initial resolution: everything within viewport + prefetch margin (1200px)
  const collect = () => page.evaluate(() => window.__bbCollect());
  const isPending = (i) => i.state == null || i.state === 'pending';
  // CSS backgrounds are detect-then-hide: they have no pending state to wait on.
  const media = (list) => list.filter((i) => i.kind !== 'background');
  // Layout shifts as images load, so keep clear of the exact margin edge. An image
  // with a CSS size is queued while the ones above it are still loading (and still
  // short), so it can be judged from a position a few hundred px higher than its final one.
  const NEAR = 900 + 1200 - 100;
  const FAR = 900 + 1200 + 600;
  const settled = await waitFor(async () => {
    const list = await collect();
    return list.length > 20 && media(list).filter((i) => i.docTop < NEAR).every((i) => !isPending(i)) ? list : null;
  });
  check('images within prefetch window resolve', !!settled,
    settled ? `${Date.now() - t0} ms from navigation`
      : JSON.stringify(media(await collect()).filter((i) => i.docTop < NEAR && isPending(i))));
  const far = media(await collect()).filter((i) => i.docTop > FAR);
  check('images far below the fold are deferred (not classified yet)', far.length > 0 && far.every(isPending),
    far.map((i) => `${i.src.slice(-30)}@${i.docTop}=${i.state}`).join(', '));

  // Sweep the page so everything scrolls near and gets classified.
  const sweep = async (done, timeout = 60_000) =>
    waitFor(async () => {
      const h = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < h; y += 700) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(350); // > the background sweep debounce
      }
      const l = await collect();
      return done(l) ? l : null;
    }, { timeout, interval: 0 });

  // ---- src swap (virtualized list): must re-hide before the new image can paint
  await page.evaluate(() => document.getElementById('swap').scrollIntoView({ block: 'center' }));
  await waitFor(async () => (await page.evaluate(() => document.getElementById('swap').getAttribute('data-tz'))) === 'clean');
  const swapState = await page.evaluate(async () => {
    window.__swap();
    await Promise.resolve();
    return document.getElementById('swap').getAttribute('data-tz');
  });
  check('src swap re-hides within the same task', swapState === 'pending', swapState);

  // ---- infinite scroll + lazy + iframes: sweep until all resolved, then compare
  await page.evaluate(() => window.__appendBatch(10));
  const list = (await sweep((l) => media(l).every((i) => !isPending(i)))) ?? (await collect());
  const wrong = media(list).filter((i) => i.state !== i.expect);
  check(`all ${media(list).length} images reach expected state`, wrong.length === 0,
    wrong.map((i) => `\n      [${i.where}] ${i.src} expected=${i.expect} got=${i.state}`).join(''));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(artifacts, 'test-page.png'), fullPage: false });

  // ---- phase 2: video
  await page.evaluate(() => window.__setupVideos());
  await page.evaluate(() => document.getElementById('videos').scrollIntoView({ block: 'center' }));
  const videos = await waitFor(async () => {
    const v = (await collect()).filter((i) => i.kind === 'video');
    return v.length === 9 && v.every((i) => i.state === i.expect) ? v : null;
  }, { timeout: 45_000 });
  check('videos reach expected state (blob, cross-origin file, DRM, paused, live, retried)', !!videos,
    videos ? '' : JSON.stringify((await collect()).filter((i) => i.kind === 'video').map((i) => `${i.expect}/${i.state}`)));
  const blockedVideos = (videos ?? []).filter((i) => i.expect === 'blocked');
  check('flagged videos are paused, except live ones', blockedVideos.length === 4 && blockedVideos.every((i) => i.paused === !i.live),
    JSON.stringify(blockedVideos.map((i) => `${i.live ? 'live' : 'vod'}:${i.paused}`)));
  check('picture-in-picture is refused', (await page.evaluate(() => window.__tryPip())) === 'NotAllowedError');
  check('every video carries disablepictureinpicture (what the right-click menu checks)',
    await page.evaluate(() => [...document.querySelectorAll('#videos video')].every((v) => v.hasAttribute('disablepictureinpicture'))));

  // ---- escape routes: no right-click menu or drag on anything blurred
  const escape = await page.evaluate(() => {
    const fire = (el, type) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const flagged = document.querySelector('#videos video[data-tz="blocked"]');
    const clean = document.querySelector('#videos video[data-tz="clean"]');
    const flaggedImg = document.querySelector('img[data-tz="blocked"]');
    return {
      menuOnBlockedVideo: fire(flagged, 'contextmenu'),
      menuOnCleanVideo: fire(clean, 'contextmenu'),
      dragBlockedImage: fire(flaggedImg, 'dragstart'),
    };
  });
  check('right-click menu blocked on a blurred video, allowed on a clean one',
    escape.menuOnBlockedVideo && !escape.menuOnCleanVideo, JSON.stringify(escape));
  check('a blurred image cannot be dragged out', escape.dragBlockedImage);

  // ---- live streams: exempt only when allowed (dev builds treat localhost as a live site)
  const liveState = () => page.evaluate(() => document.querySelector('#videos video[data-live]').getAttribute('data-tz'));
  await setSettings({ allowLiveStreams: true });
  const exempt = await waitFor(async () => (await liveState()) === 'skip', { timeout: 10_000 });
  await setSettings({ allowLiveStreams: false });
  const refiltered = await waitFor(async () => (await liveState()) === 'blocked', { timeout: 15_000 });
  check('allowLiveStreams leaves a live stream alone, and turning it off filters it again',
    !!exempt && !!refiltered, `${exempt ? 'exempt' : 'NOT exempt'}, then ${await liveState()}`);

  // ---- phase 2: CSS backgrounds
  await page.evaluate(() => document.querySelector('.bg').scrollIntoView({ block: 'center' }));
  const bgs = await waitFor(async () => {
    const b = (await collect()).filter((i) => i.kind === 'background');
    return b.length === 5 && b.every((i) => i.state === i.expect) ? b : null;
  }, { timeout: 20_000 });
  check('CSS backgrounds: flagged hidden, gradients and small ones ignored', !!bgs,
    bgs ? '' : JSON.stringify((await collect()).filter((i) => i.kind === 'background').map((i) => `${i.src.slice(0, 40)} ${i.expect}/${i.state}`)));

  // ---- settings: relaxed un-blurs the borderline image; disabling shows everything
  const borderline = () => page.evaluate(() =>
    document.querySelector('img[src*="400x400/x__tz_test_borderline"]').getAttribute('data-tz'));
  await setSettings({ preset: 'relaxed' });
  check('preset relaxed: borderline image revealed', !!(await waitFor(async () => (await borderline()) === 'clean', { timeout: 5000 })));
  await setSettings({ preset: 'strict' });
  check('preset strict: borderline image blocked', !!(await waitFor(async () => (await borderline()) === 'blocked', { timeout: 5000 })));
  await setSettings({ enabled: false });
  const allOff = await waitFor(async () => media(await collect()).every((i) => i.state === 'off'), { timeout: 10000 });
  check('disable: every image shown', !!allOff,
    allOff ? '' : JSON.stringify(media(await collect()).filter((i) => i.state !== 'off').map((i) => `${i.kind}:${i.src.slice(-28)}=${i.state}`)));
  await setSettings({ enabled: true, preset: 'balanced' });
  // Back to the top: deferred items only re-decide once they are near the viewport.
  await page.evaluate(() => window.scrollTo(0, 0));
  // Backgrounds are only re-checked where the viewport is, so compare media here.
  const backOn = await waitFor(async () => media(await collect()).filter((i) => i.state !== i.expect).length === 0, { timeout: 20000 });
  check('re-enable: states restored from cache', !!backOn,
    backOn ? '' : JSON.stringify(media(await collect()).filter((i) => i.state !== i.expect).map((i) => `${i.kind}:${i.src.slice(-28)} ${i.expect}/${i.state}`)));

  // ---- scroll smoothness while 200 fresh images classify, vs. the same load with the
  // extension disabled (headless = software compositing, so compare, don't trust absolutes)
  const scrollRun = () => page.evaluate(async () => {
    let longMs = 0;
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => (longMs += e.duration)));
    po.observe({ type: 'longtask' });
    for (let i = 0; i < 20; i++) window.__appendBatch(10);
    const gaps = [];
    let last = performance.now();
    let y = 0;
    const end = last + 4000;
    await new Promise((resolve) => {
      const tick = (now) => {
        gaps.push(now - last);
        last = now;
        y += 40;
        window.scrollTo(0, y % (document.body.scrollHeight - innerHeight));
        if (now < end) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    po.disconnect();
    gaps.sort((a, b) => a - b);
    return { frames: gaps.length, p50: gaps[Math.floor(gaps.length * 0.5)], p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps.at(-1), longMs };
  });
  const fmt = (p) =>
    `${p.frames} frames, p50 ${p.p50.toFixed(1)} / p95 ${p.p95.toFixed(1)} / max ${p.max.toFixed(1)} ms, main-thread long tasks ${Math.round(p.longMs)} ms`;
  // Steady state: let the one-time background shader warm-up finish first (it runs in
  // the shared GPU process and can stall compositing once per browser session).
  const tWarm = Date.now();
  await waitFor(async () => (await engineInfo())?.warming === false, { timeout: 60_000, interval: 500 });
  console.log(`      (background warm-up finished ${Date.now() - tWarm} ms after the idle wait began)`);
  await setSettings({ enabled: false });
  const base = await scrollRun();
  await setSettings({ enabled: true, mode: 'fast' });
  const fast = await scrollRun();
  await setSettings({ mode: 'safe' });
  const perf = await scrollRun();
  check('scroll smoothness with engine ~ baseline (p95 within 1.5x + 8ms)', perf.p95 <= base.p95 * 1.5 + 8,
    `\n      disabled:        ${fmt(base)}\n      fast (no blur):  ${fmt(fast)}\n      safe (blurred):  ${fmt(perf)}`);

  // Off-screen items only classify when scrolled near — sweep the page until done.
  const tBurst = Date.now();
  const feedDone = await sweep((l) => l.every((i) => i.state === i.expect), 120_000);
  check('400-image feed all classified correctly', !!feedDone,
    feedDone ? `${feedDone.length} imgs, sweep ${Date.now() - tBurst} ms`
      : (await collect()).filter((i) => i.state !== i.expect).slice(0, 5).map((i) => `${i.src}=${i.state}`).join(', '));

  // ---- phase 2: adult site blocking (declarativeNetRequest)
  const blockedPage = await context.newPage();
  await blockedPage.goto(`${BASE}/pages/index.html?__tz_test_adult`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('known adult site is blocked before it loads', blockedPage.url().includes('/blocked/blocked.html'), blockedPage.url());
  await setSettings({ blockAdultSites: false });
  await waitFor(async () => !(await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).includes('adult'));
  await blockedPage.goto(`${BASE}/pages/index.html?__tz_test_adult`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('site blocking can be turned off', !blockedPage.url().includes('/blocked/blocked.html'), blockedPage.url());
  await setSettings({ blockAdultSites: true });
  await blockedPage.close();

  // Hostname matching: the keyword rule must not swallow legitimate sites.
  {
    const tmp = join(artifacts, 'sites.mjs');
    await esbuild.build({ entryPoints: [join(root, 'src/shared/sites.ts')], outfile: tmp, bundle: true, format: 'esm', logLevel: 'silent' });
    const { isAdultHost } = await import(pathToFileURL(tmp).href);
    const adult = ['pornhub.com', 'www.pornhub.com', 'cdn.xvideos.com', 'freeporn-tube.net', 'best_sex_cams.tv', 'rule34.xxx'];
    const fine = ['sussex.ac.uk', 'essexlive.news', 'middlesex.gov', 'sexualhealth.nhs.uk', 'reddit.com', 'x.com', 'analytics.google.com'];
    const wrong = [...adult.filter((h) => !isAdultHost(h)), ...fine.filter((h) => isAdultHost(h))];
    check('hostname heuristic: catches adult hosts, spares lookalikes', wrong.length === 0, wrong.join(', '));
  }

  // ---- engine info + popup render
  const info = await engineInfo();
  check('classifier loaded', info?.ready, JSON.stringify(info));
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 300, height: 420 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(1200);
  await popup.screenshot({ path: join(artifacts, 'popup.png') });

  check('no page errors', errors.length === 0, errors.join('; '));
} catch (e) {
  console.error(e);
  failures.push(`crash: ${e.message}`);
} finally {
  await context?.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'ALL PASSED'} — screenshots in test/.artifacts/`);
process.exit(failures.length ? 1 : 0);

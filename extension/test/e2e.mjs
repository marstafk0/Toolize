// End-to-end test: loads the dev build into Chromium, drives test/pages/index.html,
// and asserts every image ends in its expected state. Also checks no-flash, src swaps,
// settings changes, and scroll smoothness under classification load.
//
//   npm run test:e2e              (headless)
//   HEADED=1 npm run test:e2e     (watch it)
//   NO_GPU=1 npm run test:e2e     (GPU-less machine: exercises the WASM backend)
//   CHROMIUM=/path/to/chrome      (override browser; branded Chrome ignores --load-extension)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    args: [
      `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      // Real-looking hostnames for the site-learning tests (localhost is never learned).
      '--host-resolver-rules=MAP *.test 127.0.0.1',
      ...(process.env.NO_GPU ? ['--disable-gpu'] : []),
    ],
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
  // One frame over the threshold doesn't blur a video that is already playing in the
  // clear; an obviously explicit one does.
  const addVideo = (id, tag) => page.evaluate(([id, tag]) => {
    const v = document.createElement('video');
    Object.assign(v, { src: document.querySelector('#videos video').src, muted: true, loop: true, autoplay: true, id });
    if (tag) v.dataset.tzTest = tag;
    document.getElementById('videos').prepend(v);
    v.play().catch(() => {});
  }, [id, tag]);
  const vState = (id) => page.evaluate((id) => {
    const v = document.getElementById(id);
    return { state: v.getAttribute('data-tz'), paused: v.paused };
  }, id);
  await addVideo('tolerance');
  await waitFor(async () => (await vState('tolerance')).state === 'clean', { timeout: 15_000 });
  await page.evaluate(() => (document.getElementById('tolerance').dataset.tzTest = '__tz_test_mild_once_t'));
  const seen = new Set();
  for (const end = Date.now() + 6000; Date.now() < end; ) {
    seen.add((await vState('tolerance')).state);
    await page.waitForTimeout(100);
  }
  check('one flagged frame does not blur a video that is already playing', seen.size === 1 && seen.has('clean'), [...seen].join(','));
  await page.evaluate(() => (document.getElementById('tolerance').dataset.tzTest = '__tz_test_flag'));
  const obvious = await waitFor(async () => (await vState('tolerance')).state === 'blocked', { timeout: 6000 });
  check('an obviously explicit frame still blurs it straight away', !!obvious, JSON.stringify(await vState('tolerance')));
  await page.evaluate(() => document.getElementById('tolerance').remove());

  // A new video (a Short, a feed preview) with a flagged frame stays blurred but keeps
  // playing, so it can clear itself; pausing it froze Shorts blurred for good.
  await addVideo('doubtful', '__tz_test_mild_once_d');
  const blurred = await waitFor(async () => {
    const s = await vState('doubtful');
    return s.state === 'blocked' ? s : null;
  }, { timeout: 10_000, interval: 50 });
  await page.waitForTimeout(300);
  check('a new video with one flagged frame is blurred but not paused', !!blurred && !(await vState('doubtful')).paused,
    JSON.stringify(await vState('doubtful')));
  const cleared = await waitFor(async () => (await vState('doubtful')).state === 'clean', { timeout: 10_000 });
  check('...and clears itself once its frames look clean', !!cleared, JSON.stringify(await vState('doubtful')));
  await page.evaluate(() => document.getElementById('doubtful').remove());

  // A video that looks clean from its first frame is shown at once, not after a streak.
  await addVideo('instant');
  const firstSeen = Date.now();
  await waitFor(async () => (await vState('instant')).state === 'clean', { timeout: 10_000, interval: 50 });
  check('a clean new video is shown after its first frame', Date.now() - firstSeen < 1500, `${Date.now() - firstSeen} ms`);
  await page.evaluate(() => document.getElementById('instant').remove());

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

  // ---- learning: a site with several explicit images is blocked from then on
  const learnPage = await context.newPage();
  const onBlockedPage = (p, reason) => () => p.url().includes('/blocked/blocked.html') && p.url().includes(`reason=${reason}`);
  await learnPage.goto('http://learn.test:8787/pages/frame.html', { waitUntil: 'domcontentloaded' });
  await learnPage.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      img.src = `/img/320x240/learn-${i}__tz_test_flag.png`;
      document.body.append(img);
    }
  });
  const learned = await waitFor(onBlockedPage(learnPage, 'images'), { timeout: 20_000 });
  check('a site with 3 explicit images is blocked', !!learned, learnPage.url());
  await learnPage.goto('http://learn.test:8787/pages/frame.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('a learned site stays blocked on the next visit', onBlockedPage(learnPage, 'images')(), learnPage.url());

  // Unblock from the blocked page (no desktop app here, so no key to ask for).
  await learnPage.click('#unblock');
  // The page sends itself back to the site; let that finish rather than race it.
  await waitFor(() => !learnPage.url().includes('/blocked/'), { timeout: 10_000 });
  await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('learnedSites'))).learnedSites?.length === 0);
  await learnPage.goto('http://learn.test:8787/pages/frame.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('Unblock on the blocked page lets the site load again', !learnPage.url().includes('/blocked/'), learnPage.url());

  // A self-labelled adult page is blocked on sight.
  await learnPage.goto('http://rated.test:8787/pages/rated.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const labelled = await waitFor(onBlockedPage(learnPage, 'label'), { timeout: 10_000 });
  check('a page carrying the RTA adult label is blocked', !!labelled, learnPage.url());
  await learnPage.close();

  // ---- daily list update: new domains blocked, domains dropped from the list allowed
  const shipped = JSON.parse(readFileSync(join(dist, 'rules/adult.json'), 'utf8')).find((r) => r.id === 1).condition.requestDomains;
  const seed = new Set(JSON.parse(readFileSync(join(root, 'src/shared/adult-domains.json'), 'utf8')));
  const dropped = shipped.find((d) => !seed.has(d));
  const fresh = ['# test list', ...shipped.filter((d) => d !== dropped), 'fresh-list.test'].join('\n');
  await fetch('http://localhost:8787/upload/blocklist.txt', { method: 'POST', body: fresh });
  const update = await sw.evaluate((url) => self.__tz.updateList(url), 'http://localhost:8787/media/blocklist.txt');
  const listPage = await context.newPage();
  await listPage.goto('http://fresh-list.test:8787/pages/frame.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('a domain added to the list since release is blocked after the daily update',
    listPage.url().includes('/blocked/blocked.html'), `${JSON.stringify(update)} -> ${listPage.url()}`);
  const allowRule = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).find((r) => r.action.type === 'allow');
  check('a domain dropped from the list is let through again', !!allowRule?.condition.requestDomains?.includes(dropped),
    `${dropped}: ${JSON.stringify(allowRule?.condition.requestDomains?.slice(0, 3))}`);
  // A tiny (truncated or hijacked) list must not wipe protection.
  await fetch('http://localhost:8787/upload/tiny.txt', { method: 'POST', body: 'example.com\n' });
  const tiny = await sw.evaluate((url) => self.__tz.updateList(url).then(() => 'applied', (e) => e.message), 'http://localhost:8787/media/tiny.txt');
  check('a list far smaller than the shipped one is refused', tiny !== 'applied', tiny);
  await listPage.close();

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
  // ...and the same heuristic as Chrome actually runs it (its regex rules), on hosts no
  // list contains. Chrome silently drops a regex rule over its size limit; this caught
  // that the whole layer had never been running.
  {
    const hp = await context.newPage();
    const lands = async (host) => {
      await hp.goto(`http://${host}:8787/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return hp.url().includes('/blocked/blocked.html') && !hp.url().includes('reason=words');
    };
    const blockedHosts = ['bestxxxvideos.test', 'free-milf-clips.test', 'nude-gallery.test', 'www.sex.test'];
    const fineHosts = ['sussex.test', 'analytics-dashboard.test', 'essexnews.test'];
    const missed = [];
    for (const h of blockedHosts) if (!(await lands(h))) missed.push(`${h} not blocked`);
    for (const h of fineHosts) if (await lands(h)) missed.push(`${h} blocked`);
    check('hostname rules block made-up adult hosts in Chrome itself, and spare lookalikes', missed.length === 0, missed.join(', '));

    await hp.goto('chrome://extensions/');
    const warnings = await hp.evaluate(async (id) => {
      const info = await chrome.developerPrivate.getExtensionInfo(id);
      return [...(info.manifestErrors ?? []), ...(info.installWarnings ?? []).map((w) => ({ message: w }))].map((e) => e.message);
    }, extId).catch((e) => [`could not read: ${e.message}`]);
    check('Chrome loaded every rule (no manifest or ruleset warnings)', warnings.length === 0, warnings.join(' | '));
    await hp.close();
  }

  // ---- feeds: per-site toggles from sites/*.json, and the YouTube comment-bot shield
  await setSettings({ feeds: { 'youtube.home': true, 'youtube.shorts': true, 'youtube.related': true } });
  const yt = await context.newPage();
  const shown = (sel) => yt.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);
  await yt.goto('http://youtube.test:8787/watch?v=learn1', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await shown('#grid')), { timeout: 5000 });
  check('YouTube feed toggles hide the home grid, Shorts and recommendations',
    !(await shown('#grid')) && !(await shown('#shorts-shelf')) && !(await shown('#guide-shorts')) && !(await shown('#related')),
    JSON.stringify({ grid: await shown('#grid'), shorts: await shown('#shorts-shelf'), related: await shown('#related') }));
  check('comments show by default', await shown('#sections'));
  await waitFor(async () => !(await shown('#t-bot-name')) && !(await shown('#t-bot-text')), { timeout: 3000 });
  check('porn-bot comments are hidden (fancy-font handle, "look at my profile")',
    (await shown('#t-normal')) && !(await shown('#t-bot-name')) && !(await shown('#t-bot-text')));
  const guard = () => yt.evaluate(() => {
    const cs = (s) => getComputedStyle(document.querySelector(s));
    return { avatar: cs('#t-normal #img').visibility, author: cs('#t-normal #author-text').pointerEvents,
      button: cs('#t-normal #author-thumbnail').pointerEvents, timestamp: cs('#ts').pointerEvents };
  });
  const g1 = await guard();
  check('commenter avatars hidden and profile links dead, timestamps still clickable',
    g1.avatar === 'hidden' && g1.author === 'none' && g1.button === 'none' && g1.timestamp !== 'none', JSON.stringify(g1));

  await setSettings({ feeds: { 'youtube.home': true, 'youtube.shorts': true, 'youtube.comments': true } });
  await waitFor(async () => !(await shown('#sections')), { timeout: 3000 });
  check('the Comments toggle hides comments', !(await shown('#sections')));

  await yt.goto('http://youtube.test:8787/shorts/ent1', { waitUntil: 'domcontentloaded' });
  await waitFor(() => yt.url().includes('/watch?v=ent1'), { timeout: 5000 });
  check('a Shorts link opens as a normal video', yt.url().endsWith('/watch?v=ent1'), yt.url());

  // Protection off turns everything off: feeds, comment hiding, the bot shield.
  await setSettings({ enabled: false, feeds: { 'youtube.home': true, 'youtube.shorts': true, 'youtube.comments': true } });
  await waitFor(async () => (await shown('#grid')) && (await shown('#t-bot-text')), { timeout: 3000 });
  const g2 = await guard();
  check('turning protection off shows feeds, comments and avatars again',
    (await shown('#grid')) && (await shown('#shorts-shelf')) && (await shown('#sections')) && (await shown('#t-bot-text')) && g2.avatar !== 'hidden',
    JSON.stringify(g2));
  await setSettings({ enabled: true });
  await waitFor(async () => !(await shown('#grid')) && !(await shown('#t-bot-text')), { timeout: 3000 });
  check('turning it back on hides them again', !(await shown('#grid')) && !(await shown('#sections')));
  await setSettings({ feeds: {} });
  await waitFor(async () => await shown('#grid'), { timeout: 3000 });
  check('turning a toggle off shows that part again (bots still hidden)',
    (await shown('#grid')) && (await shown('#sections')) && !(await shown('#t-bot-text')));

  // Trusted channels: videos (by the player's own channel) and thumbnails (by the tile's
  // channel link) skip the image check; other channels don't.
  await setSettings({ trustedChannels: ['Max the Meat Guy'] });
  await yt.evaluate(() => {
    const player = (id, author) => {
      const p = document.createElement('div');
      p.className = 'html5-video-player';
      p.getVideoData = () => ({ author, isLive: false });
      const v = document.createElement('video');
      Object.assign(v, { src: '/media/clip-a.webm', muted: true, loop: true, autoplay: true, id });
      v.dataset.tzTest = '__tz_test_flag';
      p.append(v);
      document.body.append(p);
      v.play().catch(() => {});
    };
    player('v-trusted', 'Max the Meat Guy');
    player('v-other', 'Someone Else');
    const tile = (id, handle) => {
      const t = document.createElement('ytd-rich-item-renderer');
      t.innerHTML = `<a href="/@${handle}">${handle}</a><img id="${id}" src="/img/320x180/${id}__tz_test_flag.png">`;
      document.body.append(t);
    };
    tile('img-trusted', 'MaxTheMeatGuy');
    tile('img-other', 'SomeoneElse');
  });
  const tz = (id) => yt.evaluate((id) => document.getElementById(id)?.getAttribute('data-tz'), id);
  await waitFor(async () => (await tz('v-other')) === 'blocked' && (await tz('img-other')) === 'blocked' && (await tz('v-trusted')) === 'skip', { timeout: 15_000 });
  const trust = { paused: await yt.evaluate(() => document.getElementById('v-trusted').paused), video: await tz('v-trusted'), img: await tz('img-trusted'), otherVideo: await tz('v-other'), otherImg: await tz('img-other') };
  const otherPaused = await yt.evaluate(() => document.getElementById('v-other').paused);
  check('on YouTube a flagged video is blurred but never paused', trust.otherVideo === 'blocked' && !otherPaused, `paused=${otherPaused}`);
  check('a trusted channel\'s videos and thumbnails skip the check; others are still blurred',
    trust.video === 'skip' && !trust.paused && trust.img === 'skip' && trust.otherVideo === 'blocked' && trust.otherImg === 'blocked', JSON.stringify(trust));
  await setSettings({ trustedChannels: [] });
  await yt.close();

  await setSettings({ feeds: { 'facebook.feed': true, 'facebook.stories': true, 'facebook.reels': true } });
  const fb = await context.newPage();
  const fbShown = (sel) => fb.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);
  await fb.goto('http://facebook.test:8787/', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await fbShown('#feed')), { timeout: 5000 });
  check('Facebook home page middle (feed, stories) and reels hidden',
    !(await fbShown('#feed')) && !(await fbShown('#stories')) && !(await fbShown('#reels-link')));
  await fb.goto('http://facebook.test:8787/groups/woodworking', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  check('a group feed is not the news feed, so it stays', (await fbShown('#feed')) && !(await fbShown('#reel-post')));
  await fb.goto('http://facebook.test:8787/reel/123', { waitUntil: 'domcontentloaded' });
  await waitFor(() => new URL(fb.url()).pathname === '/', { timeout: 5000 });
  check('a reel link goes to the home page with Reels hidden', new URL(fb.url()).pathname === '/', fb.url());
  await setSettings({ feeds: {} });
  await fb.close();

  // ---- word filter: blocked words in an address or title; YouTube tiles and videos
  const wf = await context.newPage();
  await wf.goto('http://localhost:8787/pages/frame.html?q=nude+photography+tips', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitFor(() => wf.url().includes('reason=words'), { timeout: 5000 });
  check('a search for blocked words is blocked', wf.url().includes('reason=words'), wf.url());
  await wf.goto('http://localhost:8787/pages/frame.html?q=sussex+bikini+bottom+essex', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  check('whole words only, and Bikini Bottom is fine', !wf.url().includes('/blocked/'), wf.url());
  await wf.goto('http://youtube.test:8787/watch?v=learn1', { waitUntil: 'domcontentloaded' });
  await wf.evaluate(() => {
    const tile = (id, title) => {
      const t = document.createElement('ytd-compact-video-renderer');
      t.id = id;
      t.innerHTML = `<a id="video-title" title="${title}">${title}</a>`;
      document.body.append(t);
    };
    tile('tile-ok', 'Fixing a leaky faucet');
    tile('tile-bad', 'Artistic NUDE photography session');
    tile('tile-fancy', '𝓑𝓲𝓴𝓲𝓷𝓲 try on haul');
  });
  const wfShown = (sel) => wf.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none', sel);
  await waitFor(async () => !(await wfShown('#tile-bad')), { timeout: 3000 });
  check('YouTube videos with blocked words are hidden, others stay',
    (await wfShown('#tile-ok')) && !(await wfShown('#tile-bad')) && !(await wfShown('#tile-fancy')));
  await setSettings({ blockedWords: ['faucet'] });
  await waitFor(async () => !(await wfShown('#tile-ok')), { timeout: 3000 });
  check('words of your own apply too', !(await wfShown('#tile-ok')));
  await setSettings({ blockedWords: [], wordFilter: false });
  await waitFor(async () => await wfShown('#tile-bad'), { timeout: 3000 });
  check('turning the word filter off shows them again', await wfShown('#tile-bad'));
  await setSettings({ wordFilter: true });
  await wf.close();

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

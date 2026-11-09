// End-to-end test: loads the dev build into Chromium, drives test/pages/index.html,
// and asserts every image ends in its expected state. Also checks no-flash, src swaps,
// settings changes, and scroll smoothness under classification load.
//
//   npm run test:e2e              (headless)
//   HEADED=1 npm run test:e2e     (watch it)
//   NO_GPU=1 npm run test:e2e     (GPU-less machine: exercises the WASM backend)
//   CHROMIUM=/path/to/chrome      (override browser; branded Chrome ignores --load-extension)
//   TEST_FILTER='^(A|B)[0-9]'     (only switch/false-blur regressions; regex on case names)
//   TEST_FILTER='legacy'         (only the original, sequential suite)
//   TZ_TEST_PORT=18877           (server uses this port and the following port)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';
import { runSwitchAndFalseBlur } from './switch-and-false-blur.mjs';
import { runSearchLockdown } from './search-lockdown.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = isolatedDist(join(root, 'dist'));
// Only these two harness-created temp directories may be recursively removed.
const isHarnessTemp = (path, prefix) => dirname(resolve(path)) === resolve(tmpdir()) && basename(path).startsWith(prefix);
if (!isHarnessTemp(dist, 'tz-dist-')) throw new Error(`unexpected isolated extension path: ${dist}`);
const artifacts = join(root, 'test/.artifacts');
const PORT = Number(process.env.TZ_TEST_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const filter = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER) : null;
mkdirSync(artifacts, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
  else passes++;
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

// Wait for THIS child's two listeners, rather than silently using another test run's
// server when a port is occupied. TZ_TEST_PORT also reaches the fixtures it serves.
// A port in use (another run on this machine) gets one retry after a minute.
async function startServer() {
  for (let attempt = 0; ; attempt++) {
    const child = spawn(process.execPath, [join(root, 'scripts/serve-test.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ_TEST_PORT: String(PORT) },
    });
    try {
      await new Promise((resolve, reject) => {
        let output = '';
        let errors = '';
        const timer = setTimeout(() => reject(new Error('test server startup timed out')), 10000);
        child.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes(`localhost:${PORT}\n`) && output.includes(`localhost:${PORT + 1}\n`)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr.on('data', (chunk) => { errors += chunk; });
        child.once('error', (e) => { clearTimeout(timer); reject(e); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(errors || `test server exited (${code})`)); });
      });
      return child;
    } catch (e) {
      child.kill();
      if (attempt || !/EADDRINUSE/.test(e.message)) throw e;
      console.log('test server port is in use; waiting one minute before retrying once');
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}
let server;
const profile = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
if (!isHarnessTemp(profile, 'bb-e2e-')) throw new Error(`unexpected test profile path: ${profile}`);
let context;
try {
  server = await startServer();
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    // NO_GPU=1 forces the software-GL path -> classifier should pick the WASM backend.
    args: [
      `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      // Real-looking hostnames for the site-learning tests (localhost is never learned).
      '--host-resolver-rules=MAP *.test 127.0.0.1, MAP pornhub.com 127.0.0.1, MAP tube8.com 127.0.0.1, MAP www.google.com 127.0.0.1, MAP www.bing.com 127.0.0.1, MAP duckduckgo.com 127.0.0.1, MAP www.youtube.com 127.0.0.1',
      // WebGPU for the safety model, headless included (NO_GPU runs without it).
      ...(process.env.NO_GPU ? [] : ['--enable-unsafe-webgpu']),
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

  const regressions = await runSwitchAndFalseBlur({ context, sw, setSettings, waitFor, check, filter, port: PORT, artifacts });
  if (filter && !filter.test('legacy') && !filter.test('search') && regressions.length === 0) throw new Error(`TEST_FILTER matched no cases: ${filter}`);
  if (!filter || filter.test('search')) {
    await runSearchLockdown({ context, sw, setSettings, waitFor, check, root, dist, port: PORT });
  }
  // The original suite is sequential and shares fixtures; keep it as one named group.
  if (!filter || filter.test('legacy')) {
  await setSettings({ enabled: true, preset: 'balanced', mode: 'safe', blockAdultSites: true, feeds: {}, wordFilter: true, safeSearch: true, youtubeRestrict: 'off', trustedChannels: [] });
  await sw.evaluate(async () => { await chrome.storage.local.set({ learnedSites: [] }); await self.__tz.syncDynamicRules(); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.VERBOSE) page.on('console', (m) => m.text().includes('[toolize]') && console.log('    PAGE', m.text()));
  {
    const tmp = join(artifacts, `.safety-policy-${process.pid}.mjs`); // per run: parallel runs share artifacts/
    await esbuild.build({
      stdin: { contents: "export * from './policy'; export { verdictReasons } from './verdicts';", resolveDir: join(root, 'src/shared') },
      outfile: tmp, bundle: true, format: 'esm', logLevel: 'silent',
    });
    const { decide, isExplicit, verdictReasons, PRESETS } = await import(pathToFileURL(tmp).href);
    const r = { whole: { drawing: 0, hentai: 0, neutral: 0.01, porn: 0.99, sexy: 0 }, safety: 0.1, width: 320, height: 240 };
    const enabledPorn = { ...PRESETS.balanced, pornBesideSafety: 0.97 };
    check('optional porn trigger blocks, learns and explains when enabled', decide(r, enabledPorn) === 'blocked' &&
      isExplicit(r, enabledPorn) && verdictReasons(r, enabledPorn).some((s) => s.startsWith('porn ') && s.endsWith('(beside safety)')));
    const boundary = { ...r, whole: { ...r.whole, hentai: 0.5, porn: 0, neutral: 0.5 } };
    check('hentai threshold equality stays clean and does not learn', decide(boundary, PRESETS.balanced) === 'clean' && !isExplicit(boundary, PRESETS.balanced));
    check('hentai beside-safety thresholds increase across presets', PRESETS.strict.hentaiBesideSafety < PRESETS.balanced.hentaiBesideSafety &&
      PRESETS.balanced.hentaiBesideSafety < PRESETS.relaxed.hentaiBesideSafety);
  }
  // Hentai evidence still blocks when safety underrates it; the porn trigger is
  // disabled because the measured candidate added FPs without recovering misses.
  const besideSafetyPage = await context.newPage();
  await besideSafetyPage.goto(`${BASE}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  await besideSafetyPage.evaluate(() => {
    for (const tag of ['hentai_only', 'porn_only']) {
      const img = new Image();
      img.id = tag;
      img.src = `/img/320x240/beside-safety__tz_test_${tag}.png`;
      document.body.prepend(img);
    }
  });
  for (const tag of ['hentai_only', 'porn_only']) {
    const expected = tag === 'hentai_only' ? 'blocked' : 'clean';
    check(`${tag} is ${expected} beside safety=0.1`, !!(await waitFor(() => besideSafetyPage.evaluate(({ id, expected }) =>
      document.getElementById(id).getAttribute('data-tz') === expected, { id: tag, expected }))));
  }
  const besideSafetyVerdicts = await waitFor(() => sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    const rows = (await chrome.storage.session.get('tabVerdicts')).tabVerdicts?.[tab?.id] ?? [];
    return rows.filter((v) => v.scores.safety === 0.1).length === 2 ? rows : null;
  }, besideSafetyPage.url()));
  check('hentai beside-safety verdict explains the trigger', !!besideSafetyVerdicts?.some((v) =>
    v.scores.safety === 0.1 && v.why.some((why) => why.startsWith('hentai ') && why.endsWith('(beside safety)'))));
  await besideSafetyPage.close();
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

  // A delayed fetch failure must not extract a recycled node's new pixels under the
  // old URL's cache key. Both the page cache and the offscreen cache are exercised by
  // inserting the original URL again after the old request has settled.
  const recycle = await context.newPage();
  await recycle.goto(`${BASE}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  await recycle.evaluate(() => {
    const img = document.createElement('img');
    img.id = 'recycled';
    img.dataset.tzTest = '__tz_test_clean__tz_test_fail_once_recycled__tz_test_fetch_failure';
    img.src = '/img/320x240/recycled-old__tz_test_flag.png';
    document.body.prepend(img);
  });
  await waitFor(() => recycle.evaluate(() => document.getElementById('recycled').getAttribute('data-tz') === 'pending'));
  await recycle.waitForTimeout(400);
  await recycle.evaluate(() => (document.getElementById('recycled').src = '/img/320x240/recycled-new__tz_test_clean.png'));
  await waitFor(() => recycle.evaluate(() => document.getElementById('recycled').getAttribute('data-tz') === 'clean'));
  await recycle.waitForTimeout(1500);
  await recycle.evaluate(() => {
    const img = document.createElement('img');
    img.id = 'original-again';
    img.src = '/img/320x240/recycled-old__tz_test_flag.png';
    document.body.prepend(img);
  });
  const unpoisoned = await waitFor(() => recycle.evaluate(() => document.getElementById('original-again').getAttribute('data-tz') === 'blocked'));
  check('fetch fallback from a recycled image does not poison the old URL cache', !!unpoisoned);
  await recycle.close();

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

  // A disable must resume only videos Toolize paused; re-enable must sample a video
  // that never left the viewport, even if its previous verdict was clean or blocked.
  await page.evaluate(() => {
    const flagged = document.querySelector('#videos video[data-tz-test="__tz_test_flag"]');
    flagged.id = 'switch-video';
    const still = document.querySelector('#videos video:not([autoplay])[data-tz="blocked"]');
    still.id = 'user-paused';
  });
  await setSettings({ enabled: false });
  const resumed = await waitFor(() => page.evaluate(() => {
    const v = document.getElementById('switch-video');
    return v.getAttribute('data-tz') === 'off' && !v.paused;
  }), { timeout: 3000, interval: 50 });
  check('disable resumes a flagged video paused by Toolize and stamps off', !!resumed);
  check('disable preserves a video the user had paused', await page.evaluate(() => document.getElementById('user-paused').paused));
  // A clean tag ensures the next verdict cannot just be the restored blocked one.
  await page.evaluate(() => (document.getElementById('switch-video').dataset.tzTest = '__tz_test_clean'));
  await setSettings({ enabled: true });
  const freshVideo = await waitFor(() => page.evaluate(() => document.getElementById('switch-video').getAttribute('data-tz') === 'clean'),
    { timeout: 3000, interval: 50 });
  check('re-enable samples the still-visible video afresh within 3 seconds', !!freshVideo);
  await page.evaluate(() => {
    const v = document.getElementById('switch-video');
    v.dataset.tzTest = '__tz_test_flag';
    v.dispatchEvent(new Event('play'));
  });
  await waitFor(() => page.evaluate(() => document.getElementById('switch-video').getAttribute('data-tz') === 'blocked'));

  // Intrinsically tiny videos have a terminal skip state, including after resize.
  await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    c.getContext('2d').fillRect(0, 0, 48, 48);
    const v = document.createElement('video');
    Object.assign(v, { id: 'tiny-video', muted: true, autoplay: true, srcObject: c.captureStream(1) });
    document.getElementById('videos').prepend(v);
    v.play().catch(() => {});
    c.getContext('2d').fillRect(0, 0, 48, 48);
  });
  const tinyVideo = await waitFor(() => page.evaluate(() => {
    const v = document.getElementById('tiny-video');
    return v.videoWidth === 48 && v.videoHeight === 48 && v.getAttribute('data-tz') === 'skip';
  }), { timeout: 5000 });
  check('a 48x48 video is skipped rather than left pending', !!tinyVideo);
  await page.evaluate(() => document.getElementById('tiny-video').remove());
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

  // Use one video on a separate page so every debug sample belongs to this test.
  // The safety-only overrides run even without WebGPU; no explicit pixels are used.
  const safetyVideoPage = await context.newPage();
  await safetyVideoPage.goto(`${BASE}/pages/regressions.html`, { waitUntil: 'domcontentloaded' });
  const frameSamples = [];
  safetyVideoPage.on('console', (msg) => {
    const prefix = '[toolize:video-frame] ';
    if (msg.text().startsWith(prefix)) frameSamples.push(JSON.parse(msg.text().slice(prefix.length)));
  });
  await safetyVideoPage.evaluate(() => {
    const v = document.createElement('video');
    Object.assign(v, { src: '/media/clip-a.webm', muted: true, loop: true, autoplay: true });
    v.dataset.tzTest = '__tz_test_clean';
    document.body.append(v);
    v.play().catch(() => {});
  });
  const safetyTag = (tag) => safetyVideoPage.evaluate((tag) => { document.querySelector('video').dataset.tzTest = tag; }, tag);
  await waitFor(() => safetyVideoPage.evaluate(() => document.querySelector('video').getAttribute('data-tz') === 'clean'));
  await safetyTag('__tz_test_safety_only');
  const spike = await waitFor(() => frameSamples.find((s) => s.safety === 0.95), { timeout: 6000, interval: 25 });
  await safetyTag('__tz_test_clean'); // exactly one noisy frame, then ordinary clean frames
  await waitFor(() => frameSamples.length >= 4 && frameSamples.at(-1).window.every((f) => f === 'clean'), { timeout: 15_000 });
  check('a shown video tolerates one safety-only 0.95 frame', !!spike && spike.neutral === 1 && !spike.obvious &&
    spike.verdict === 'clean' && frameSamples.filter((s) => s.safety === 0.95).length === 1 &&
    frameSamples.every((s) => s.verdict === 'clean'), JSON.stringify(spike));
  frameSamples.length = 0;
  await safetyTag('__tz_test_flag');
  const explicit = await waitFor(() => frameSamples[0], { timeout: 6000, interval: 25 });
  check('a shown video blurs on the first corroborated explicit frame', explicit?.porn === 0.99 && explicit.obvious &&
    explicit.verdict === 'blocked' && (process.env.NO_GPU || explicit.safety === 0.99) &&
    explicit.window.filter((f) => f === 'flagged').length === 1, JSON.stringify(explicit));
  // Borderline safety without NSFWJS agreement must not strand a new preview hidden.
  await safetyVideoPage.evaluate(() => document.querySelector('video').remove());
  frameSamples.length = 0;
  await safetyVideoPage.evaluate(() => {
    const v = document.createElement('video');
    Object.assign(v, { src: '/media/clip-a.webm', muted: true, loop: true, autoplay: true });
    v.dataset.tzTest = '__tz_test_safety_borderline';
    document.body.append(v);
    v.play().catch(() => {});
  });
  const borderlineSafety = await waitFor(() => frameSamples[0], { timeout: 6000 });
  check('a new preview reveals on borderline safety-only 0.6', borderlineSafety?.safety === 0.6 &&
    borderlineSafety.neutral === 1 && borderlineSafety.frame === 'clean' && borderlineSafety.verdict === 'clean', JSON.stringify(borderlineSafety));
  await safetyVideoPage.close();
  await page.bringToFront();

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

  // Backgrounds inside nested shadow roots are found by descending only into the roots
  // under each sampled point (probing every root froze Reddit).
  await page.evaluate(() => {
    const outer = document.createElement('div');
    outer.id = 'bg-shadow';
    outer.style.cssText = 'width:600px;height:400px';
    document.querySelector('.bg').before(outer);
    // Many unrelated roots, like a component-heavy page.
    for (let i = 0; i < 300; i++) document.body.appendChild(document.createElement('span')).attachShadow({ mode: 'open' });
    const inner = outer.attachShadow({ mode: 'open' }).appendChild(document.createElement('div'));
    inner.style.cssText = 'width:600px;height:400px';
    const el = inner.attachShadow({ mode: 'open' }).appendChild(document.createElement('div'));
    el.style.cssText = 'width:600px;height:400px;background-size:cover;background-image:url(/img/400x300/bg-shadow__tz_test_flag.png)';
    outer.scrollIntoView({ block: 'center' });
  });
  const shadowBg = await waitFor(() => page.evaluate(() => {
    const el = document.getElementById('bg-shadow').shadowRoot.firstElementChild.shadowRoot.firstElementChild;
    return el.getAttribute('data-tz-bg') === 'blocked';
  }), { timeout: 20_000 });
  check('a flagged background two shadow roots deep is hidden', !!shadowBg);
  await page.evaluate(() => document.getElementById('bg-shadow').remove());

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
  // A policy change now invalidates video verdicts, including paused stills. Bring
  // those videos into view so they can be re-judged before comparing every state.
  await page.evaluate(() => document.getElementById('videos').scrollIntoView({ block: 'center' }));
  await waitFor(async () => media(await collect()).filter((i) => i.kind === 'video').every((i) => i.state === i.expect));
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
  await learnPage.goto(`http://learn.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  await learnPage.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      const img = document.createElement('img');
      img.src = `/img/320x240/learn-${i}__tz_test_flag.png`;
      document.body.append(img);
    }
  });
  const learned = await waitFor(onBlockedPage(learnPage, 'images'), { timeout: 20_000 });
  check('a site with 3 explicit images is blocked', !!learned, learnPage.url());
  await learnPage.goto(`http://learn.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('a learned site stays blocked on the next visit', onBlockedPage(learnPage, 'images')(), learnPage.url());

  // The master switch removes both the static list and learned dynamic rules.
  await setSettings({ enabled: false });
  await waitFor(async () => sw.evaluate(async () =>
    !(await chrome.declarativeNetRequest.getEnabledRulesets()).includes('adult') &&
    !(await chrome.declarativeNetRequest.getDynamicRules()).length));
  await learnPage.goto(`http://learn.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  check('master disable lets a learned host load', !learnPage.url().includes('/blocked/'), learnPage.url());
  const listedPage = await context.newPage();
  // Real list membership, independent of the development-only test URL rule.
  await listedPage.goto(`http://pornhub.com:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  check('master disable lets a listed adult host load', !listedPage.url().includes('/blocked/'), listedPage.url());
  await setSettings({ enabled: true });
  await waitFor(async () => sw.evaluate(async () =>
    (await chrome.declarativeNetRequest.getEnabledRulesets()).includes('adult') &&
    (await chrome.declarativeNetRequest.getDynamicRules()).some((r) => r.condition.requestDomains?.includes('learn.test'))));
  await learnPage.goto(`http://learn.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await listedPage.goto(`http://pornhub.com:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('re-enable blocks both learned and listed hosts again',
    onBlockedPage(learnPage, 'images')() && listedPage.url().includes('/blocked/'), `${learnPage.url()} | ${listedPage.url()}`);
  await listedPage.close();

  // Unblock from the blocked page (no desktop app here, so no key to ask for).
  await learnPage.click('#unblock');
  // The page sends itself back to the site; let that finish rather than race it.
  await waitFor(() => !learnPage.url().includes('/blocked/'), { timeout: 10_000 });
  await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('learnedSites'))).learnedSites?.length === 0);
  await learnPage.goto(`http://learn.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('Unblock on the blocked page lets the site load again', !learnPage.url().includes('/blocked/'), learnPage.url());

  const illustratedPage = await context.newPage();
  await illustratedPage.goto(`http://illustrated.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  await illustratedPage.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      const img = new Image();
      img.src = `/img/320x240/learn-${i}__tz_test_hentai_only.png`;
      document.body.append(img);
    }
  });
  check('3 hentai images learn a site even with safety=0.1', !!(await waitFor(onBlockedPage(illustratedPage, 'images'), { timeout: 20_000 })));
  await illustratedPage.close();

  // A self-labelled adult page is blocked on sight.
  await learnPage.goto(`http://rated.test:${PORT}/pages/rated.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const labelled = await waitFor(onBlockedPage(learnPage, 'label'), { timeout: 10_000 });
  check('a page carrying the RTA adult label is blocked', !!labelled, learnPage.url());
  await learnPage.close();

  // ---- daily list update: new domains blocked, domains dropped from the list allowed
  const shipped = JSON.parse(readFileSync(join(dist, 'rules/adult.json'), 'utf8')).find((r) => r.id === 1).condition.requestDomains;
  const seed = new Set(JSON.parse(readFileSync(join(root, 'src/shared/adult-domains.json'), 'utf8')));
  const dropped = shipped.find((d) => !seed.has(d));
  const fresh = ['# test list', ...shipped.filter((d) => d !== dropped), 'fresh-list.test'].join('\n');
  await fetch(`http://localhost:${PORT}/upload/blocklist.txt`, { method: 'POST', body: fresh });
  const update = await sw.evaluate((url) => self.__tz.updateList(url), `http://localhost:${PORT}/media/blocklist.txt`);
  const listPage = await context.newPage();
  await listPage.goto(`http://fresh-list.test:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  check('a domain added to the list since release is blocked after the daily update',
    listPage.url().includes('/blocked/blocked.html'), `${JSON.stringify(update)} -> ${listPage.url()}`);
  const allowRule = (await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).find((r) => r.action.type === 'allow');
  check('a domain dropped from the list is let through again', !!allowRule?.condition.requestDomains?.includes(dropped),
    `${dropped}: ${JSON.stringify(allowRule?.condition.requestDomains?.slice(0, 3))}`);
  // A tiny (truncated or hijacked) list must not wipe protection.
  await fetch(`http://localhost:${PORT}/upload/tiny.txt`, { method: 'POST', body: 'example.com\n' });
  const tiny = await sw.evaluate((url) => self.__tz.updateList(url).then(() => 'applied', (e) => e.message), `http://localhost:${PORT}/media/tiny.txt`);
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
      await hp.goto(`http://${host}:${PORT}/pages/frame.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
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
  await yt.goto(`http://youtube.test:${PORT}/watch?v=learn1`, { waitUntil: 'domcontentloaded' });
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

  await yt.goto(`http://youtube.test:${PORT}/shorts/ent1`, { waitUntil: 'domcontentloaded' });
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
  await yt.evaluate(() => {
    const a = document.createElement('a');
    a.href = '/@MaxTheMeatGuy';
    a.textContent = 'Max the Meat Guy';
    document.getElementById('img-other').closest('ytd-rich-item-renderer').append(a);
  });
  const lateChannel = await waitFor(async () => (await tz('img-other')) === 'skip', { timeout: 3000 });
  check('a trusted channel link arriving after the thumbnail verdict reconsiders it', !!lateChannel);
  await setSettings({ trustedChannels: [] });
  await yt.close();

  await setSettings({ feeds: { 'facebook.feed': true, 'facebook.stories': true, 'facebook.reels': true } });
  const fb = await context.newPage();
  const fbShown = (sel) => fb.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);
  await fb.goto(`http://facebook.test:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await fbShown('#feed')), { timeout: 5000 });
  check('Facebook home page middle (feed, stories) and reels hidden',
    !(await fbShown('#feed')) && !(await fbShown('#stories')) && !(await fbShown('#reels-link')));
  await fb.goto(`http://facebook.test:${PORT}/groups/woodworking`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  check('a group feed is not the news feed, so it stays', (await fbShown('#feed')) && !(await fbShown('#reel-post')));
  await fb.goto(`http://facebook.test:${PORT}/reel/123`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => new URL(fb.url()).pathname === '/', { timeout: 5000 });
  check('a reel link goes to the home page with Reels hidden', new URL(fb.url()).pathname === '/', fb.url());
  await setSettings({ feeds: {} });
  await fb.close();

  // Match the real hosts too: *.test alone would miss a catalog host typo.
  for (const dev of [true, false]) {
    const tmp = join(artifacts, `feeds-${dev ? 'dev' : 'prod'}.mjs`);
    await esbuild.build({
      entryPoints: [join(root, 'src/shared/feeds.ts')], outfile: tmp, bundle: true,
      format: 'esm', define: { __DEV__: String(dev) }, logLevel: 'silent',
    });
    const { siteForHost } = await import(pathToFileURL(tmp).href);
    const hosts = {
      'x.com': 'x', 'twitter.com': 'x', 'mobile.twitter.com': 'x',
      'www.reddit.com': 'reddit', 'old.reddit.com': 'reddit',
      'www.instagram.com': 'instagram', 'www.linkedin.com': 'linkedin', 'www.tiktok.com': 'tiktok',
    };
    const wrong = Object.entries(hosts).filter(([host, site]) => siteForHost(host)?.id !== site);
    const sites = ['x', 'reddit', 'instagram', 'linkedin', 'tiktok'];
    const testHosts = sites.every((site) => siteForHost(`${site}.test`)?.id === (dev ? site : undefined));
    const lookalikes = ['notx.com', 'notreddit.com', 'twitter.com.example.org', 'instagram.com.example.org', 'linkedin.com.example.org', 'tiktok.com.example.org'];
    check(`feed catalog matches real hosts and subdomains (${dev ? 'dev' : 'production'})`, wrong.length === 0, JSON.stringify(wrong));
    check(`feed test hosts are dev-only and lookalikes do not match (${dev ? 'dev' : 'production'})`,
      testHosts && lookalikes.every((host) => !siteForHost(host)));
  }

  // The fixtures deliberately reuse feed-shaped light DOM on non-feed routes. Test
  // each setting on its own, including inherited visibility when a container hides.
  const feedCases = [
    {
      key: 'x.home', paths: ['/home?view=following', '/?view=for-you'],
      hidden: ['#home-timeline', '#timeline-region'], visible: ['#page-title', '#trends', '#sidebar-search'],
      safe: ['/someone', '/someone/status/123', '/status/123', '/search?q=woodworking', '/notifications', '/messages', '/explore'],
      notice: '#primary',
    },
    {
      key: 'x.explore', paths: ['/explore?tab=trending', '/explore/tabs/for-you'],
      hidden: ['#timeline-region', '#trends', '#who-to-follow', '#explore-link'], visible: ['#page-title', '#sidebar-search'],
      safe: ['/home', '/someone/status/123'],
    },
    {
      key: 'x.sidebar', paths: ['/home', '/explore', '/someone/status/123'],
      hidden: ['#trends', '#who-to-follow'], visible: ['#home-timeline', '#timeline-region', '#page-title', '#sidebar-search', '#explore-link'],
      safe: ['/someone'],
    },
    {
      key: 'reddit.home', paths: ['/', '/r/popular', '/r/all/?t=day', '/best', '/hot', '/new', '/top?t=week', '/rising'],
      hidden: ['#feed', '#siteTable'], visible: ['#post', '#comment-tree', '#right-sidebar-container'],
      safe: ['/r/woodworking', '/r/x/comments/123/a-post', '/comments/123/a-post', '/search/?q=woodworking'],
      notice: '#main-content',
    },
    {
      key: 'reddit.sidebar', paths: ['/'],
      hidden: ['#right-sidebar-container', '#recent-communities', '#popular-communities', '#popular-link', '#all-link'],
      visible: ['#feed', '#post', '#comment-tree', '#subreddit-link'], safe: ['/r/woodworking', '/r/x/comments/123/a-post'],
    },
    {
      key: 'reddit.related', paths: ['/r/x/comments/123/a-post?sort=top', '/comments/123/a-post'],
      hidden: ['#related-posts', '#recommendations', '#more-posts'], visible: ['#post', '#comment-tree', '#feed'],
      safe: ['/', '/r/woodworking', '/search/?q=woodworking'],
    },
    {
      key: 'instagram.home', paths: ['/?source=home'], hidden: ['#feed-container', '#feed-post'],
      visible: ['#stories', '#profile-content', '#messages-link'],
      safe: ['/direct/inbox/', '/explore/', '/someone/', '/p/abc/'], notice: '#main',
    },
    {
      key: 'instagram.explore', paths: ['/'], hidden: ['#explore-link'],
      visible: ['#feed-post', '#stories', '#messages-link'], safe: ['/p/abc/'],
      redirects: ['/explore', '/explore/', '/explore/tags/woodworking/?source=nav'],
    },
    {
      key: 'instagram.reels', paths: ['/'], hidden: ['#reels-link'],
      visible: ['#feed-post', '#stories', '#messages-link'], safe: ['/p/abc/', '/someone/'],
      redirects: ['/reels', '/reels/', '/reels/abc/?source=nav'],
    },
    {
      key: 'instagram.stories', paths: ['/?source=home'], hidden: ['#stories', '#stories-container'],
      visible: ['#feed-post', '#profile-content', '#messages-link'], safe: ['/p/abc/', '/direct/inbox/', '/someone/'],
    },
    {
      key: 'linkedin.home', paths: ['/feed/', '/?trk=home', '/feed?trk=nav'],
      hidden: ['#feed', '#update', '#voyager-feed', '#rail-feed'], visible: ['#composer', '#news', '#messages-link', '#jobs-link'],
      safe: ['/in/someone/', '/messaging/', '/jobs/', '/search/', '/feed-news/'], notice: '#main',
    },
    {
      key: 'linkedin.news', paths: ['/feed/'], hidden: ['#news', '#right-rail'],
      visible: ['#feed', '#update', '#composer', '#messages-link', '#jobs-link'], safe: ['/in/someone/'],
    },
    {
      key: 'tiktok.foryou', paths: ['/', '/foryou', '/en/', '/foryou/?lang=en'],
      hidden: ['#recommend-item', '#main-content-homepage_hot', '#video-feed'], visible: ['#page-title', '#profile-link', '#explore-link'],
      safe: ['/@user', '/@user/video/123', '/search?q=woodworking', '/explore'], notice: '#main',
    },
    {
      key: 'tiktok.explore', paths: ['/explore'], hidden: ['#main-content-explore_page', '#explore-item', '#explore-link'],
      visible: ['#recommend-item', '#page-title', '#profile-link'], safe: ['/@user', '/@user/video/123'],
    },
    {
      key: 'tiktok.live', paths: ['/'], hidden: ['#live-link', '#main-content-live'],
      visible: ['#recommend-item', '#page-title', '#profile-link'], safe: ['/@user', '/@user/video/123'],
      redirects: ['/live', '/live/', '/live/123?source=nav'],
    },
  ];
  for (const c of feedCases) {
    const site = c.key.split('.')[0];
    const feedPage = await context.newPage();
    const origin = `http://${site}.test:${PORT}`;
    const feeds = { [c.key]: true };
    const states = (selectors, visible) => feedPage.evaluate(({ selectors, visible }) => selectors.every((s) => {
      const e = document.querySelector(s);
      return !!e && e.checkVisibility() === visible;
    }), { selectors, visible });
    const go = async (path) => {
      const response = await feedPage.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) throw new Error(`missing feed fixture: ${site}${path}`);
      await feedPage.waitForFunction(() => !!document.querySelector('style[data-toolize="feeds"]'));
    };
    await setSettings({ enabled: true, feeds });
    for (const path of c.paths) {
      await go(path);
      await waitFor(() => states(c.hidden, false), { timeout: 5000 });
      check(`${c.key} hides its targets on ${path} and keeps other content`,
        (await states(c.hidden, false)) && (await states(c.visible, true)));
      if (c.notice) {
        const notice = await feedPage.evaluate((s) => getComputedStyle(document.querySelector(s), '::before').content, c.notice);
        check(`${c.key} shows a replacement notice on ${path}`, notice.includes('hidden by Toolize'), notice);
      }
    }
    for (const path of c.safe) {
      await go(path);
      // Path-limited toggles must leave even matching feed markup alone here.
      const pathLimited = ['x.home', 'x.explore', 'reddit.home', 'reddit.related', 'instagram.home', 'instagram.stories', 'linkedin.home', 'tiktok.foryou'].includes(c.key);
      check(`${c.key} keeps non-feed content on ${path}`,
        (await states(c.visible, true)) && (!pathLimited || (await states(c.hidden, true))));
    }
    // SPA navigation reuses the same DOM and must rebuild path-scoped rules.
    if (c.notice) {
      await feedPage.evaluate((path) => history.pushState({}, '', path), c.paths[0]);
      await waitFor(() => states(c.hidden, false), { timeout: 5000 });
      check(`${c.key} reapplies after SPA navigation to the feed`, await states(c.hidden, false));
      await feedPage.evaluate((path) => history.pushState({}, '', path), c.safe[0]);
      await waitFor(() => states(c.hidden, true), { timeout: 5000 });
      const notice = await feedPage.evaluate((s) => getComputedStyle(document.querySelector(s), '::before').content, c.notice);
      check(`${c.key} restores content and removes the notice after SPA navigation away`,
        (await states(c.hidden, true)) && !notice.includes('hidden by Toolize'));
    }
    for (const path of c.redirects ?? []) {
      await feedPage.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
      await waitFor(() => feedPage.url() === `${origin}/`, { timeout: 5000 });
      check(`${c.key} redirects ${path} to home`, feedPage.url() === `${origin}/`, feedPage.url());
    }
    await go(c.paths[0]);
    await waitFor(() => states(c.hidden, false), { timeout: 5000 });
    await setSettings({ feeds: {} });
    await waitFor(() => states(c.hidden, true), { timeout: 5000 });
    check(`${c.key} can be turned off independently`, await states([...c.hidden, ...c.visible], true));
    await setSettings({ feeds });
    await waitFor(() => states(c.hidden, false), { timeout: 5000 });
    await setSettings({ enabled: false });
    await waitFor(() => states(c.hidden, true), { timeout: 5000 });
    check(`${c.key} shows everything when protection is off`, await states([...c.hidden, ...c.visible], true));
    for (const path of c.redirects ?? []) {
      await go(path);
      // Allow the SPA poll time to run too; protection off must suppress redirects.
      await feedPage.waitForTimeout(400);
      check(`${c.key} leaves ${path} alone when protection is off`, feedPage.url() === `${origin}${path}`, feedPage.url());
    }
    await feedPage.close();
  }
  await setSettings({ enabled: true, feeds: {} });

  // ---- word filter: blocked words in an address or title; YouTube tiles and videos
  const wf = await context.newPage();
  await wf.goto(`http://localhost:${PORT}/pages/frame.html?q=nude+photography+tips`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitFor(() => wf.url().includes('reason=search'), { timeout: 5000 });
  check('a search for blocked words is blocked', wf.url().includes('reason=search'), wf.url());
  await wf.goto(`http://localhost:${PORT}/pages/frame.html?q=sussex+bikini+bottom+essex`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  check('whole words only, and Bikini Bottom is fine', !wf.url().includes('/blocked/'), wf.url());
  await wf.goto(`http://youtube.test:${PORT}/watch?v=learn1`, { waitUntil: 'domcontentloaded' });
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
  const feedVerdicts = await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    return (await chrome.storage.session.get('tabVerdicts')).tabVerdicts?.[tab?.id] ?? [];
  }, page.url());
  check('the large image burst keeps only the most recent 60 verdicts', feedVerdicts.length === 60);

  // Use a small, settled page so the earlier 400-image burst cannot evict the video
  // verdict before the popup checks. These are existing deterministic score hooks.
  const verdictPage = await context.newPage();
  await verdictPage.goto(`${BASE}/pages/frame.html`, { waitUntil: 'domcontentloaded' });
  await verdictPage.evaluate(() => {
    for (const tag of ['flag', 'clean']) {
      const img = new Image();
      img.src = `/img/320x240/verdict-${tag}__tz_test_${tag}.png`;
      document.body.append(img);
    }
    const video = document.createElement('video');
    Object.assign(video, { id: 'verdict-video', src: '/media/clip-a.webm', muted: true, loop: true, autoplay: true });
    video.dataset.tzTest = '__tz_test_flag';
    document.body.prepend(video);
    video.play().catch(() => {});
  });
  const verdictTabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, verdictPage.url());
  await waitFor(() => verdictPage.evaluate(() => document.getElementById('verdict-video').getAttribute('data-tz') === 'blocked'));
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 300, height: 420 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  // Opening popup.html in a test tab makes it active; restore the tab a real popup
  // would inspect without adding a testing-only popup argument or content hook.
  await sw.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), verdictTabId);
  // Runtime messages must originate in another extension context: a service worker
  // does not receive its own sendMessage(), whereas the real popup queries this API.
  const getVerdicts = () => popup.evaluate((tabId) => chrome.runtime.sendMessage({ target: 'background', kind: 'getTabVerdicts', tabId }), verdictTabId);
  const entries = await waitFor(async () => {
    const rows = await getVerdicts();
    return rows.some((v) => v.kind === 'image' && v.decision === 'clean') &&
      rows.some((v) => v.kind === 'image' && v.decision === 'blocked') &&
      rows.some((v) => v.kind === 'video' && v.decision === 'blocked') ? rows : null;
  });
  check('tab verdicts include image and video classifications', !!entries);
  check('blocked verdicts explain the applied policy', !!entries && entries.filter((v) => v.decision === 'blocked')
    .every((v) => v.why.length > 0 && v.why.every((why) => typeof why === 'string' && why.length > 0)));
  const privateStrings = (value) => typeof value === 'string' ? [value] :
    value && typeof value === 'object' ? Object.values(value).flatMap(privateStrings) : [];
  const imageNames = [...new Set((await collect()).filter((v) => v.kind === 'image').map((v) => v.src.split('/').at(-1)).filter(Boolean)),
    'verdict-flag__tz_test_flag.png', 'verdict-clean__tz_test_clean.png', 'clip-a.webm'];
  const leaks = (entries ?? []).flatMap(privateStrings).filter((value) => /https?:|\//.test(value) || imageNames.some((name) => value.includes(name)));
  check('verdicts contain scores only, with no URLs or media names', !!entries && leaks.length === 0, JSON.stringify(leaks));
  check('video verdict includes the triggering frame and window', !!entries?.some((v) => v.kind === 'video' &&
    v.frameInfo?.frame === 'flagged' && v.frameInfo.obvious && v.frameInfo.window.at(-1) === 'flagged'));
  check('tab verdicts are newest first and bounded to 60', !!entries && entries.length <= 60 && entries.every((v, i) => i === 0 || entries[i - 1].at >= v.at));
  const stored = await sw.evaluate(async (tabId) => (await chrome.storage.session.get('tabVerdicts')).tabVerdicts?.[tabId], verdictTabId);
  check('verdicts live in session storage', !!stored?.length && stored.length === entries?.length);

  await popup.waitForFunction(() => document.querySelectorAll('.verdict-row').length >= 2);
  check('verdict section starts collapsed with blurred-only enabled', await popup.evaluate(() =>
    !document.getElementById('verdicts').open && document.getElementById('verdict-blurred-only').checked));
  await popup.locator('#verdicts > summary').click();
  check('blurred-only filter hides clean verdicts', await popup.locator('.verdict-pill.clean').count() === 0 && await popup.locator('.verdict-pill.blocked').count() >= 2);
  await popup.locator('#verdict-blurred-only').uncheck();
  check('turning off the filter includes shown verdicts', await popup.locator('.verdict-pill.clean').count() > 0);
  await popup.locator('.verdict-row > summary').first().click();
  check('expanded verdict shows full scores', await popup.locator('.verdict-row[open] .verdict-scores').first().innerText().then((text) => /porn \d\.\d{2}/.test(text) && /balanced/.test(text)));
  // Capture the exact clipboard payload without granting a permission to the extension.
  await popup.evaluate(() => { navigator.clipboard.writeText = async (text) => { window.__copiedVerdicts = text; }; });
  await popup.locator('#verdict-blurred-only').check();
  await popup.locator('#verdict-copy').click();
  const copied = await popup.evaluate(() => window.__copiedVerdicts);
  check('copy includes only visible verdicts and full scores', typeof copied === 'string' && copied.includes('blurred') &&
    !copied.includes('shown') && /porn \d\.\d{2}/.test(copied) && !/https?:|\//.test(copied));
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('verdicts').open);
  check('popup remembers the verdict section open state', await popup.locator('#verdicts').evaluate((el) => el.open));
  await popup.locator('.verdict-row > summary').first().click();
  await popup.screenshot({ path: join(artifacts, 'popup.png'), fullPage: true });

  await popup.evaluate((tabId) => chrome.runtime.sendMessage({ target: 'background', kind: 'clearTabVerdicts', tabId }), verdictTabId);
  check('clearTabVerdicts removes the current tab buffer', (await getVerdicts()).length === 0);
  // A stable flagged paused frame must not refill the log after it was cleared.
  await verdictPage.waitForTimeout(1500);
  check('stable video verdicts are not recorded again', (await getVerdicts()).length === 0);
  await verdictPage.evaluate(() => {
    const img = new Image();
    img.src = '/img/320x240/verdict-navigation__tz_test_flag.png';
    document.body.prepend(img);
  });
  await waitFor(async () => (await getVerdicts()).length > 0);
  await verdictPage.goto(`${BASE}/pages/regressions.html`, { waitUntil: 'domcontentloaded' });
  check('navigation drops the tab verdict buffer', (await getVerdicts()).length === 0);
  await verdictPage.evaluate(() => {
    const img = new Image();
    img.src = '/img/320x240/verdict-close__tz_test_flag.png';
    document.body.prepend(img);
  });
  await waitFor(async () => (await getVerdicts()).length > 0);
  await verdictPage.close();
  check('closing a tab drops its verdict buffer', !!(await waitFor(async () => (await getVerdicts()).length === 0)));

  check('popup shows SafeSearch enabled and YouTube restriction off by default',
    await popup.locator('#safeSearch').isChecked() &&
    await popup.locator('#youtubeRestrict button[data-value="off"]').getAttribute('aria-pressed') === 'true');
  await popup.locator('label[title="Safe search"]').click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.safeSearch === false);
  check('popup SafeSearch switch saves through the settings path', !(await popup.locator('#safeSearch').isChecked()));
  await popup.locator('#youtubeRestrict button[data-value="strict"]').click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.youtubeRestrict === 'strict');
  check('popup YouTube segmented control saves and renders Strict',
    await popup.locator('#youtubeRestrict button[data-value="strict"]').getAttribute('aria-pressed') === 'true');
  await setSettings({ safeSearch: true, youtubeRestrict: 'off' });

  check('no page errors', errors.length === 0, errors.join('; '));
  }
} catch (e) {
  console.error(e);
  failures.push(`crash: ${e.message}`);
} finally {
  await context?.close();
  server?.kill();
  rmSync(profile, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures.length} failed — ${failures.length ? 'FAILED' : 'ALL PASSED'} — screenshots in test/.artifacts/`);
process.exit(failures.length ? 1 : 0);

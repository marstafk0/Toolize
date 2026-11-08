// Deterministic regressions for the protection master switch and false blurs.
// Run through e2e.mjs: TEST_FILTER='^(A|B)[0-9]' (PowerShell: $env:TEST_FILTER=...).
// Every case gets a fresh page and a complete settings reset. No native messaging:
// the parent harness loads isolatedDist(), even on machines with Toolize installed.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  enabled: true, preset: 'balanced', mode: 'safe', blockAdultSites: true,
  allowLiveStreams: false, feeds: {}, wordFilter: true, blockedWords: [], trustedChannels: [],
};

export async function runSwitchAndFalseBlur({ context, sw, setSettings, waitFor, check, filter, port, artifacts }) {
  const origin = (host = 'localhost') => `http://${host}:${port}`;
  const fixture = `${origin()}/pages/regressions.html`;
  const runId = `${Date.now()}`;
  const results = [];
  let clips;

  const state = (p, id) => p.evaluate((id) => {
    const el = document.getElementById(id);
    return { state: el?.getAttribute('data-tz'), filter: el && getComputedStyle(el).filter,
      paused: el?.paused, time: el?.currentTime, ready: el?.readyState, width: el?.videoWidth };
  }, id);
  const expectState = async (p, id, expected, timeout = 8000) => {
    const done = await waitFor(async () => (await state(p, id)).state === expected, { timeout, interval: 50 });
    assert.ok(done, `${id}: expected data-tz=${expected}; actual ${JSON.stringify(await state(p, id))}`);
  };
  const go = async (p, url) => {
    await p.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      // DNR redirects can abort the original navigation. Other errors are setup failures.
      if (!/ERR_ABORTED|interrupted by another navigation/.test(e.message)) throw e;
    });
    await p.waitForTimeout(400); // storage listeners / the 250-300ms page guards
  };
  const blocked = (p) => p.url().includes('/blocked/blocked.html');
  const image = async (p, id, tag, { delay = 0 } = {}) => {
    const src = `/img/240x160/${id}-${runId}${tag}.png${delay ? `?delay=${delay}` : ''}`;
    // Decode before insertion so fail_once reaches the retry path, rather than the
    // separate early-fetch path which waits for the load event when still loading.
    await p.evaluate(async ({ id, src }) => {
      const img = new Image();
      img.id = id;
      img.src = src;
      await img.decode();
      document.body.append(img);
    }, { id, src });
    return src;
  };

  async function ensureClips(p) {
    if (clips) return;
    clips = await p.evaluate(async (runId) => {
      // As in harness.js, record synthetic pixels locally; no binary fixtures or
      // external videos. A separate 32px source exercises the intrinsic size guard.
      const recordings = [320, 32].map((size) => {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const stream = c.captureStream(15);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start();
        return { c, rec, stream, chunks, size };
      });
      const start = performance.now();
      await new Promise((resolve) => {
        const draw = (now) => {
          for (const { c, size } of recordings) {
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#287dba';
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = '#69b680';
            ctx.fillRect(((now - start) / 8) % size, 0, size / 4, size);
          }
          now - start < 1500 ? requestAnimationFrame(draw) : resolve();
        };
        requestAnimationFrame(draw);
      });
      return Promise.all(recordings.map(async ({ rec, stream, chunks, size }) => {
        await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
        stream.getTracks().forEach((t) => t.stop());
        const name = `switch-${runId}-${size}.webm`;
        const response = await fetch(`/upload/${name}`, { method: 'POST', body: new Blob(chunks, { type: 'video/webm' }) });
        if (!response.ok) throw new Error(`clip upload: ${response.status}`);
        return `/media/${name}`;
      }));
    }, runId);
  }

  async function video(p, id, tag = '__tz_test_clean', { small = false, paused = false, author } = {}) {
    await ensureClips(p);
    await p.evaluate(async ({ id, src, tag, paused, author }) => {
      const v = document.createElement('video');
      Object.assign(v, { id, src, muted: true, loop: true, preload: 'auto', playsInline: true });
      v.dataset.tzTest = tag;
      if (author) v.dataset.tzAuthor = author;
      await new Promise((resolve, reject) => {
        v.onloadeddata = resolve;
        v.onerror = () => reject(new Error(`video decode: ${v.error?.message}`));
      });
      // MediaRecorder WebM initially reports Infinity. Resolve the real duration
      // before discovery: otherwise the VOD pause test accidentally tests a live stream.
      if (!Number.isFinite(v.duration)) {
        await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = 1e6; });
      }
      await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = 0; });
      if (!Number.isFinite(v.duration)) throw new Error('fixture must be finite VOD');
      document.body.prepend(v);
      if (!paused) await v.play();
    }, { id, src: clips[small ? 1 : 0], tag, paused, author });
  }

  // Run in the extension's existing isolated world, including a selected iframe.
  // Dev esbuild preserves TS-private property names. Only the transport response is
  // held: no scores, watcher state, settings, or product decisions are changed.
  const probe = async (p, action, args = {}, frameUrl = p.url()) => sw.evaluate(async ({ pageUrl, frameUrl, action, args }) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === pageUrl);
    if (!tab?.id) throw new Error(`test tab missing: ${pageUrl}`);
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (frameUrl, action, args) => {
        if (location.href !== frameUrl) return null;
        const engine = globalThis.__toolizeEngine;
        if (!engine?.client) throw new Error('dev content engine not ready');
        if (action === 'install') {
          const g = globalThis.__tzRegressionGate = { ready: [], delivered: [], released: false };
          const route = engine.client.route.bind(engine.client);
          const released = new Promise((resolve) => { g.release = resolve; });
          engine.client.route = async (req) => {
            const response = await route(req);
            const tag = req.testTag ?? req.source.url ?? req.source.videoUrl ?? '';
            if (tag.includes(args.token)) {
              const entry = { tag, ok: response.ok };
              g.ready.push(entry);
              if (!args.successOnly || response.ok) await released;
              g.delivered.push(entry);
            }
            return response;
          };
          return true;
        }
        const g = globalThis.__tzRegressionGate;
        if (action === 'release') { g.released = true; g.release(); }
        return { ready: g.ready, delivered: g.delivered, released: g.released };
      }, args: [frameUrl, action, args],
    });
    return out.map((r) => r.result).find((r) => r != null);
  }, { pageUrl: p.url(), frameUrl, action, args });

  const watch = (p, selector = 'img, video') => p.evaluate((selector) => {
    window.__tzTransitions = [];
    window.__tzStateObserver = new MutationObserver((records) => {
      for (const r of records) if (r.target.matches(selector)) {
        window.__tzTransitions.push({ id: r.target.id, state: r.target.getAttribute('data-tz') });
      }
    });
    window.__tzStateObserver.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-tz'] });
  }, selector);
  const transitions = (p) => p.evaluate(() => window.__tzTransitions);
  // MAIN-world overrides do not change document.hidden in the isolated world.
  const visibility = async (p, hidden) => sw.evaluate(async ({ url, hidden }) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    }, args: [hidden] });
  }, { url: p.url(), hidden });

  async function test(name, fn) {
    if (filter && !filter.test(name)) return;
    const assertions = [];
    const verify = (label, ok, detail = '') => {
      check(`${name}: ${label}`, !!ok, detail);
      assertions.push({ label, pass: !!ok, detail });
    };
    let p;
    let timer;
    try {
      await setSettings(DEFAULTS);
      // Only harness storage; never request settings from the installed companion.
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ learnedSites: [] });
        await self.__tz.syncDynamicRules();
      });
      p = await context.newPage();
      p.setDefaultTimeout(12_000);
      if (process.env.VERBOSE) p.on('console', (m) => m.text().includes('[toolize]') && console.log('    REGRESSION', m.text()));
      await Promise.race([
        fn(p, verify),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('case exceeded 45s')), 45000); }),
      ]);
    } catch (e) {
      verify('assertion/setup', false, e.stack ?? e.message);
    } finally {
      clearTimeout(timer);
      await p?.close();
    }
    const pass = assertions.length > 0 && assertions.every((a) => a.pass);
    results.push({ name, pass, assertions });
    console.log(`CASE ${pass ? 'PASS' : 'FAIL'} ${name}`);
  }

  await test('A1-static-and-regex-master-switch', async (p, verify) => {
    // tube8.com is a seed without a hostname keyword; the other host hits regex only.
    // Both resolve locally, so this never requests a real adult site.
    for (const host of ['tube8.com', 'switch-porn.test']) {
      const url = `${origin(host)}/pages/regressions.html`;
      await go(p, url);
      assert.ok(blocked(p), `positive control: ${host} must block while enabled; ${p.url()}`);
      await setSettings({ enabled: false, blockAdultSites: true });
      await p.waitForTimeout(500);
      await go(p, url);
      verify(`${host} loads with enabled=false`, p.url() === url, `expected ${url}; actual ${p.url()}`);
      await setSettings({ enabled: true });
      await p.waitForTimeout(500);
      await go(p, url);
      verify(`${host} blocks again without restart`, blocked(p), p.url());
    }
  });

  await test('A2-learned-master-switch', async (p, verify) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ learnedSites: [{ site: 'switch-learn.test', reason: 'images', at: Date.now() }] });
      await self.__tz.syncDynamicRules();
    });
    const url = `${origin('switch-learn.test')}/pages/frame.html`;
    await go(p, url);
    assert.ok(blocked(p) && p.url().includes('reason=images'), `positive control: learned rule missing: ${p.url()}`);
    await setSettings({ enabled: false });
    await p.waitForTimeout(500);
    await go(p, url);
    verify('learned site loads while off', p.url() === url, `expected ${url}; actual ${p.url()}`);
    await setSettings({ enabled: true });
    await p.waitForTimeout(500);
    await go(p, url);
    verify('learned block returns on re-enable', blocked(p) && p.url().includes('reason=images'), p.url());
  });

  await test('A3-words-master-switch', async (p, verify) => {
    await setSettings({ enabled: false });
    const url = `${fixture}?q=nude+photography`;
    await go(p, url);
    await p.waitForTimeout(700);
    verify('default word in URL does not redirect', p.url() === url, p.url());
    await go(p, fixture);
    await p.evaluate(() => { document.title = 'NUDE photography'; });
    await p.waitForTimeout(700);
    verify('default word in title does not redirect', p.url() === fixture, p.url());
    await go(p, `${origin('youtube.test')}/watch?v=switch`);
    await p.evaluate(() => {
      const tile = document.createElement('ytd-compact-video-renderer');
      tile.id = 'word-tile';
      tile.innerHTML = '<a id="video-title" title="NUDE photography">NUDE photography</a>';
      document.body.append(tile);
    });
    await p.waitForTimeout(700);
    const tile = await p.locator('#word-tile').evaluate((e) => ({ marked: e.hasAttribute('data-tz-words'), display: getComputedStyle(e).display }));
    verify('YouTube word tile stays shown and unmarked', !tile.marked && tile.display !== 'none', JSON.stringify(tile));
    await setSettings({ enabled: true });
    verify('positive control: word tile hides on re-enable', !!await waitFor(() => p.locator('#word-tile').evaluate((e) => e.hasAttribute('data-tz-words'))));
  });

  await test('A4-youtube-feeds-bots-shorts-master-switch', async (p, verify) => {
    await setSettings({ feeds: { 'youtube.home': true, 'youtube.shorts': true, 'youtube.related': true, 'youtube.comments': true } });
    await go(p, `${origin('youtube.test')}/watch?v=switch`);
    assert.ok(await waitFor(() => p.locator('#t-bot-text').evaluate((e) => e.hasAttribute('data-tz-bot'))), 'positive control: bot shield must run');
    await setSettings({ enabled: false });
    await p.waitForTimeout(700);
    const off = await p.evaluate(() => ({
      hidden: ['grid', 'shorts-shelf', 'guide-shorts', 'related', 'sections', 't-bot-name', 't-bot-text']
        .filter((id) => getComputedStyle(document.getElementById(id)).display === 'none'),
      style: !!document.querySelector('style[data-toolize="youtube"]')?.isConnected,
      bots: document.querySelectorAll('[data-tz-bot]').length,
      avatar: getComputedStyle(document.querySelector('#t-normal #img')).visibility,
      author: getComputedStyle(document.querySelector('#t-normal #author-text')).pointerEvents,
    }));
    verify('all feeds/comments shown, guard style disconnected, no bot markers',
      off.hidden.length === 0 && !off.style && off.bots === 0 && off.avatar !== 'hidden' && off.author !== 'none', JSON.stringify(off));
    const shorts = `${origin('youtube.test')}/shorts/switch`;
    await go(p, shorts);
    await p.waitForTimeout(700);
    verify('Shorts URL stays put while off', p.url() === shorts, p.url());
    await setSettings({ enabled: true });
    verify('Shorts redirects again when enabled', !!await waitFor(() => p.url() === `${origin('youtube.test')}/watch?v=switch`, { timeout: 4000 }), p.url());
  });

  await test('A5-open-page-disable-reenable', async (p, verify) => {
    await go(p, fixture);
    await image(p, 'clean-img', '__tz_test_clean');
    await image(p, 'flag-img', '__tz_test_flag');
    await video(p, 'clean-video');
    await video(p, 'flag-video', '__tz_test_flag');
    await p.evaluate((runId) => {
      const bg = document.createElement('div');
      bg.id = 'background';
      bg.className = 'background';
      bg.style.backgroundImage = `url(/img/400x300/${runId}__tz_test_flag.png)`;
      document.body.append(bg);
      dispatchEvent(new Event('resize')); // trigger the viewport background sweep
    }, runId);
    await expectState(p, 'clean-video', 'clean');
    await expectState(p, 'flag-video', 'blocked');
    assert.equal((await state(p, 'flag-video')).paused, true, 'positive control: flagged VOD paused');
    assert.ok(await waitFor(() => p.locator('#background').evaluate((e) => e.hasAttribute('data-tz-bg'))), 'background must first be blocked');
    await setSettings({ enabled: false });
    const allOff = await waitFor(() => p.evaluate(() => [...document.querySelectorAll('img,video')].every((e) => e.getAttribute('data-tz') === 'off')), { timeout: 4000 });
    const off = await p.evaluate(() => ({ media: [...document.querySelectorAll('img,video')].map((e) => [e.id, e.getAttribute('data-tz'), getComputedStyle(e).filter]), backgrounds: document.querySelectorAll('[data-tz-bg]').length }));
    verify('all images/videos off and shown, backgrounds restored', allOff && off.backgrounds === 0 && off.media.every(([, , f]) => !f.includes('blur')), JSON.stringify(off));
    await p.locator('#flag-video').evaluate((v) => v.play());
    await p.waitForTimeout(1300);
    verify('previously flagged video can play while disabled', !(await state(p, 'flag-video')).paused, JSON.stringify(await state(p, 'flag-video')));
    await setSettings({ enabled: true });
    const back = await waitFor(async () => (await state(p, 'clean-img')).state === 'clean' && (await state(p, 'clean-video')).state === 'clean', { timeout: 5000 });
    verify('clean media returns to clean without reload', !!back, JSON.stringify([await state(p, 'clean-img'), await state(p, 'clean-video')]));
  });

  await test('A5-reenable-pending-video-without-reload', async (p, verify) => {
    await go(p, fixture);
    await ensureClips(p);
    await visibility(p, true);
    await video(p, 'pending-video');
    await expectState(p, 'pending-video', 'pending');
    await setSettings({ enabled: false });
    await expectState(p, 'pending-video', 'off');
    await visibility(p, false);
    await setSettings({ enabled: true });
    const clean = await waitFor(async () => (await state(p, 'pending-video')).state === 'clean', { timeout: 5000 });
    verify('pending video resumes classification after re-enable', !!clean, JSON.stringify(await state(p, 'pending-video')));
  });

  await test('A5-inflight-image-after-disable', async (p, verify) => {
    await go(p, fixture);
    const token = `A5-image-${runId}`;
    await probe(p, 'install', { token, successOnly: true });
    await image(p, token, '__tz_test_fail_once__tz_test_clean', { delay: 600 });
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.some((r) => r.ok), { timeout: 12000 }), 'retry must produce a real successful response held in flight');
    const before = await probe(p, 'status');
    assert.ok(before.ready.some((r) => !r.ok), 'must exercise fail_once before successful retry');
    await setSettings({ enabled: false });
    await expectState(p, token, 'off');
    await watch(p);
    await probe(p, 'release');
    await p.waitForTimeout(1000);
    const changes = await transitions(p);
    verify('slow retried image response cannot overwrite off', (await state(p, token)).state === 'off' && changes.every((c) => c.state === 'off'), JSON.stringify({ changes, actual: await state(p, token) }));
    await setSettings({ enabled: true });
    verify('re-enable reveals the clean retry without reload', !!await waitFor(async () => (await state(p, token)).state === 'clean', { timeout: 4000 }), JSON.stringify(await state(p, token)));
  });

  async function flightVideo(p, verify, iframe = false) {
    await go(p, fixture);
    let target = p;
    if (iframe) {
      await p.evaluate(() => {
        const f = document.createElement('iframe');
        f.src = '/pages/frame.html';
        document.body.append(f);
      });
      await p.locator('iframe').waitFor();
      target = await p.locator('iframe').elementHandle().then((e) => e.contentFrame());
      await target.waitForLoadState('domcontentloaded');
      await target.evaluate(() => { document.body.replaceChildren(); });
    }
    const token = `flight-video-${iframe}-${runId}__tz_test_flag`;
    await probe(p, 'install', { token }, target.url());
    await video(target, 'flight-video', token);
    assert.ok(await waitFor(async () => (await probe(p, 'status', {}, target.url())).ready.length > 0, { timeout: 10000 }), 'real flagged frame must be held in flight');
    await setSettings({ enabled: false });
    await expectState(target, 'flight-video', 'off');
    await watch(target);
    await probe(p, 'release', {}, target.url());
    await target.waitForTimeout(1000);
    const actual = await state(target, 'flight-video');
    const changes = await transitions(target);
    verify('late flagged frame stays off, shown and playing', actual.state === 'off' && !actual.paused && !actual.filter.includes('blur') && changes.every((c) => c.state === 'off'), JSON.stringify({ actual, changes }));
  }
  await test('A5-inflight-video-after-disable', (p, verify) => flightVideo(p, verify));

  await test('A5-inflight-poster-after-disable', async (p, verify) => {
    await go(p, fixture);
    const token = `poster-${runId}`;
    await probe(p, 'install', { token });
    await p.evaluate((token) => {
      const v = document.createElement('video');
      v.id = 'poster';
      v.poster = `/img/240x160/${token}__tz_test_flag.png?delay=400`;
      document.body.append(v);
    }, token);
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.length > 0), 'poster response must be held');
    await setSettings({ enabled: false });
    await expectState(p, 'poster', 'off');
    await watch(p);
    await probe(p, 'release');
    await p.waitForTimeout(800);
    const changes = await transitions(p);
    verify('late poster verdict cannot re-blur', (await state(p, 'poster')).state === 'off' && changes.every((c) => c.state === 'off'), JSON.stringify({ actual: await state(p, 'poster'), changes }));
  });

  await test('A5-inflight-background-error-after-disable', async (p, verify) => {
    await go(p, fixture);
    const token = `bg-error-${runId}`;
    await probe(p, 'install', { token });
    await p.evaluate((token) => {
      const bg = document.createElement('div');
      bg.id = 'background';
      bg.className = 'background';
      bg.style.backgroundImage = `url(/img/400x300/${token}__tz_test_fail_once.png)`;
      document.body.append(bg);
      dispatchEvent(new Event('resize'));
    }, token);
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.some((r) => !r.ok)), 'real transient background failure must be held');
    await setSettings({ enabled: false });
    await p.waitForTimeout(300);
    await probe(p, 'release');
    await p.waitForTimeout(800);
    const actual = await p.locator('#background').evaluate((e) => ({ mark: e.getAttribute('data-tz-bg'), background: getComputedStyle(e).backgroundImage }));
    verify('late failure cannot hide background while off', actual.mark === null && actual.background !== 'none', JSON.stringify(actual));
  });

  await test('A6-iframe-inflight-image-after-disable', async (p, verify) => {
    await go(p, fixture);
    await p.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = '/pages/frame.html';
      document.body.append(f);
    });
    const f = await waitFor(() => p.frames().find((f) => f.url().endsWith('/pages/frame.html')));
    assert.ok(f, 'same-origin frame must load');
    await f.waitForLoadState('domcontentloaded');
    await f.evaluate(() => { document.body.replaceChildren(); });
    const token = `iframe-image-${runId}`;
    await probe(p, 'install', { token }, f.url());
    await image(f, token, '__tz_test_flag', { delay: 500 });
    assert.ok(await waitFor(async () => (await probe(p, 'status', {}, f.url())).ready.length > 0), 'iframe classification must be in flight');
    await setSettings({ enabled: false });
    await expectState(f, token, 'off');
    await watch(f);
    await probe(p, 'release', {}, f.url());
    await f.waitForTimeout(800);
    const changes = await transitions(f);
    verify('same-origin iframe image stays off after response', (await state(f, token)).state === 'off' && changes.every((c) => c.state === 'off'), JSON.stringify({ actual: await state(f, token), changes }));
  });
  await test('A6-iframe-inflight-video-after-disable', (p, verify) => flightVideo(p, verify, true));

  for (const paused of [false, true]) await test(`B1-single-mild-${paused ? 'paused-seek' : 'playing'}`, async (p, verify) => {
    await go(p, fixture);
    await video(p, 'tolerance');
    await expectState(p, 'tolerance', 'clean');
    if (paused) await p.locator('#tolerance').evaluate((v) => v.pause());
    const token = `__tz_test_mild_once_${paused ? 'still' : 'playing'}_${runId}__tz_test_clean`;
    await probe(p, 'install', { token });
    await watch(p, '#tolerance');
    await p.locator('#tolerance').evaluate(async (v, { token, paused }) => {
      v.dataset.tzTest = token;
      if (paused) await new Promise((resolve) => {
        v.addEventListener('seeked', resolve, { once: true });
        v.currentTime = v.currentTime < 0.5 ? 0.8 : 0.2;
      });
    }, { token, paused });
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.length > 0, { timeout: 6000 }), 'mild frame must actually be classified');
    await probe(p, 'release');
    await p.waitForTimeout(paused ? 1000 : 4500);
    const actual = await state(p, 'tolerance');
    const changes = await transitions(p);
    // CLAUDE.md applies the 2-of-3 / obvious rule once shown. recordStill currently
    // disagrees: frame === 'flagged' alone blurs a previously clean paused video.
    verify('one non-obvious flagged frame never blurs a shown video', actual.state === 'clean' && changes.every((c) => c.state === 'clean'), JSON.stringify({ actual, changes }));
  });

  for (const youtube of [false, true]) await test(`B2-obvious-${youtube ? 'youtube-never-paused' : 'vod-paused'}`, async (p, verify) => {
    await go(p, youtube ? `${origin('youtube.test')}/watch?v=explicit` : fixture);
    await video(p, 'obvious');
    await expectState(p, 'obvious', 'clean');
    await p.locator('#obvious').evaluate((v) => {
      window.__tzPauseEvents = 0;
      v.addEventListener('pause', () => window.__tzPauseEvents++);
      v.dataset.tzTest = '__tz_test_flag';
    });
    await expectState(p, 'obvious', 'blocked', 6000);
    await p.waitForTimeout(700);
    const actual = await state(p, 'obvious');
    const pauses = await p.evaluate(() => window.__tzPauseEvents);
    verify('explicit frame blurs, with correct pause behavior', actual.filter.includes('blur') && (youtube ? !actual.paused && pauses === 0 : actual.paused && pauses > 0), JSON.stringify({ actual, pauses }));
  });

  await test('B3-image-transient-failure-recovers', async (p, verify) => {
    await go(p, fixture);
    const token = `retry-${runId}`;
    await probe(p, 'install', { token, successOnly: true });
    await image(p, token, '__tz_test_fail_once__tz_test_clean');
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.some((r) => !r.ok), { timeout: 4000 }), 'first request must really fail');
    // images.ts retries at 1500ms, then 3000ms (3 attempts total).
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.some((r) => r.ok), { timeout: 8000 }), 'automatic retry must really succeed');
    await probe(p, 'release');
    const clean = await waitFor(async () => (await state(p, token)).state === 'clean', { timeout: 3000 });
    verify('transient failure ends clean, not error', !!clean, JSON.stringify(await state(p, token)));
  });

  await test('B4-idle-video-posters', async (p, verify) => {
    await go(p, fixture);
    await p.evaluate((runId) => {
      for (const flag of [false, true]) {
        const v = document.createElement('video');
        v.id = flag ? 'poster-flag' : 'poster-clean';
        v.poster = `/img/240x160/poster-${runId}${flag ? '__tz_test_flag' : '__tz_test_clean'}.png`;
        document.body.append(v); // intentionally no src / playback; the poster is all the user sees
      }
    }, runId);
    await expectState(p, 'poster-clean', 'clean');
    await expectState(p, 'poster-flag', 'blocked');
    const clean = await state(p, 'poster-clean');
    const flag = await state(p, 'poster-flag');
    verify('clean poster reveals idle video; flagged poster stays blurred', clean.paused && flag.paused && !clean.filter.includes('blur') && flag.filter.includes('blur'), JSON.stringify({ clean, flag }));
  });

  await test('B5-image-src-swaps-both-directions', async (p, verify) => {
    await go(p, fixture);
    await image(p, 'swap', '__tz_test_flag');
    await expectState(p, 'swap', 'blocked');
    for (const [tag, expected] of [['__tz_test_clean', 'clean'], ['__tz_test_flag', 'blocked']]) {
      await watch(p, '#swap');
      await p.locator('#swap').evaluate((img, src) => { img.src = src; }, `/img/240x160/swapped-${runId}${tag}.png?delay=300`);
      const settled = await waitFor(async () => (await state(p, 'swap')).state === expected, { timeout: 8000 });
      const changes = await transitions(p);
      verify(`swapped source reaches ${expected} after pending`, !!settled && changes.some((c) => c.state === 'pending'), JSON.stringify({ actual: await state(p, 'swap'), changes }));
    }
  });

  for (const oldFlag of [true, false]) await test(`B5-inflight-src-swap-${oldFlag ? 'flag-to-clean' : 'clean-to-flag'}`, async (p, verify) => {
    await go(p, fixture);
    const token = `old-${oldFlag}-${runId}`;
    await probe(p, 'install', { token });
    await image(p, token, oldFlag ? '__tz_test_flag' : '__tz_test_clean', { delay: 500 });
    assert.ok(await waitFor(async () => (await probe(p, 'status')).ready.length > 0), 'old source verdict must be in flight');
    const expected = oldFlag ? 'clean' : 'blocked';
    await p.locator(`[id="${token}"]`).evaluate((img, src) => { img.src = src; }, `/img/240x160/new-${oldFlag}-${runId}${oldFlag ? '__tz_test_clean' : '__tz_test_flag'}.png`);
    await expectState(p, token, expected);
    await watch(p);
    await probe(p, 'release');
    await p.waitForTimeout(800);
    const changes = await transitions(p);
    verify('old result cannot overwrite the new source verdict', (await state(p, token)).state === expected && changes.every((c) => c.state === expected), JSON.stringify({ actual: await state(p, token), changes }));
  });

  for (const small of [true, false]) await test(`B6-${small ? 'tiny-video' : 'paused-hover-preview'}-settles`, async (p, verify) => {
    await go(p, fixture);
    await video(p, 'idle', '__tz_test_clean', { small, paused: true });
    const settled = await waitFor(async () => ['skip', 'clean', 'blocked'].includes((await state(p, 'idle')).state), { timeout: 5000, interval: 50 });
    verify('never-played video gets a real verdict or skip within 5s', !!settled, JSON.stringify(await state(p, 'idle')));
  });

  await test('B7-hidden-pending-video-recovers-on-visible', async (p, verify) => {
    await go(p, fixture);
    await visibility(p, true);
    await video(p, 'hidden-video');
    await expectState(p, 'hidden-video', 'pending');
    await p.waitForTimeout(700);
    assert.equal((await state(p, 'hidden-video')).state, 'pending', 'must actually be pending while hidden');
    await visibility(p, false);
    verify('visible tab gets a verdict within 5s', !!await waitFor(async () => (await state(p, 'hidden-video')).state === 'clean', { timeout: 5000 }), JSON.stringify(await state(p, 'hidden-video')));
  });

  await test('B8-trusted-youtube-thumbnail-and-video', async (p, verify) => {
    await setSettings({ trustedChannels: ['@Trusted'] });
    await go(p, `${origin('youtube.test')}/watch?v=trusted`);
    await p.evaluate((runId) => {
      for (const handle of ['Trusted', 'Other']) {
        const tile = document.createElement('ytd-rich-item-renderer');
        tile.innerHTML = `<a href="/@${handle}">${handle}</a><img id="thumb-${handle}" src="/img/240x160/${handle}-${runId}__tz_test_flag.png">`;
        document.body.prepend(tile);
      }
    }, runId);
    await video(p, 'trusted-video', '__tz_test_flag', { author: 'Trusted' });
    await video(p, 'other-video', '__tz_test_flag', { author: 'Other' });
    await expectState(p, 'thumb-Trusted', 'skip');
    await expectState(p, 'trusted-video', 'skip');
    await expectState(p, 'thumb-Other', 'blocked');
    await expectState(p, 'other-video', 'blocked');
    await p.waitForTimeout(1500); // ensure later flagged frames cannot undo the exemption
    const actual = { thumb: await state(p, 'thumb-Trusted'), video: await state(p, 'trusted-video') };
    verify('trusted handle and data-tz-author stay skip despite explicit tags', actual.thumb.state === 'skip' && actual.video.state === 'skip' && !actual.video.paused, JSON.stringify(actual));
  });

  const report = join(artifacts, `switch-and-false-blur-${process.env.NO_GPU ? 'no-gpu' : 'gpu'}-${runId}.json`);
  writeFileSync(report, JSON.stringify({ port, noGpu: !!process.env.NO_GPU, filter: filter?.source, results }, null, 2));
  if (results.length) console.log(`Regression cases: ${results.filter((r) => r.pass).length}/${results.length} passed`);
  if (results.length) console.log(`Regression results: ${report}`);
  return results;
}

// Reddit with and without the extension, in a browser launched without automation
// flags (Playwright's own launch gets Reddit's bot wall). Counts requests to Reddit by
// who made them: the page, or the extension refetching images to classify them.
//   node test/reddit-traffic.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const url = process.argv[2] ?? 'https://www.reddit.com/r/pics/';
const ext = isolatedDist(join(import.meta.dirname, '../dist'));

async function run(withExt, port) {
  const proc = spawn(findChromium(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tz-rt-'))}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    ...(withExt ? [`--load-extension=${ext}`] : []), 'about:blank',
  ], { stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  try {
    const ctx = browser.contexts()[0];
    if (withExt) await new Promise((r) => setTimeout(r, 5000)); // classifier warm-up
    const cdp = await browser.newBrowserCDPSession();
    // Every request in the browser, including the extension's offscreen document.
    const reqs = [];
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const page = await ctx.newPage();
    const pcdp = await ctx.newCDPSession(page);
    await pcdp.send('Network.enable');
    pcdp.on('Network.responseReceived', (e) => reqs.push({ who: 'page', url: e.response.url, bytes: 0, status: e.response.status, id: e.requestId }));
    pcdp.on('Network.loadingFinished', (e) => { const r = reqs.find((x) => x.id === e.requestId && x.who === 'page'); if (r) r.bytes = e.encodedDataLength; });
    if (withExt) {
      const off = await waitForOffscreen(browser);
      if (off) {
        await off.send('Network.enable');
        off.on('Network.responseReceived', (e) => reqs.push({ who: 'ext', url: e.response.url, bytes: 0, status: e.response.status, id: e.requestId, cached: e.response.fromDiskCache }));
        off.on('Network.loadingFinished', (e) => { const r = reqs.find((x) => x.id === e.requestId && x.who === 'ext'); if (r) r.bytes = e.encodedDataLength; });
      } else console.log('  (offscreen document not found)');
    }
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 }).catch((e) => console.log('  goto:', e.message.slice(0, 80)));
    const load = Date.now() - t0;
    const title = await page.title();
    if (withExt) await pcdp.send('Profiler.enable'), await pcdp.send('Profiler.setSamplingInterval', { interval: 1000 }), await pcdp.send('Profiler.start');
    const gaps = await page.evaluate(() => new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      const end = last + 10_000;
      const step = (t) => {
        gaps.push(t - last);
        last = t;
        window.scrollBy(0, 25);
        if (t < end) requestAnimationFrame(step);
        else resolve(gaps);
      };
      requestAnimationFrame(step);
    }));
    if (withExt) {
      const { profile } = await pcdp.send('Profiler.stop');
      const self = new Map();
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const dt = profile.timeDeltas;
      profile.samples.forEach((id, i) => {
        const n = byId.get(id);
        const f = n.callFrame;
        const k = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber}`;
        self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
      });
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      console.log('  main thread profile, total ms', total.toFixed(0));
      for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log('   ', v.toFixed(0).padStart(6), k);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const imgs = await page.evaluate(() => [...document.querySelectorAll('img,video')].reduce((m, e) => {
      const k = e.getAttribute('data-tz') ?? 'none';
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {}));
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', withExt ? '-ext.png' : '.png') });
    const s = [...gaps].sort((a, b) => a - b);
    const by = (who) => reqs.filter((r) => r.who === who);
    const mb = (rs) => (rs.reduce((a, r) => a + r.bytes, 0) / 1e6).toFixed(1);
    const ext = by('ext');
    console.log(`${withExt ? 'with extension' : 'without'}: "${title.slice(0, 40)}" load ${load} ms; scroll frames ${s.length}, p95 ${s[Math.floor(s.length * 0.95)].toFixed(0)} ms, max ${s.at(-1).toFixed(0)} ms, >50ms ${gaps.filter((g) => g > 50).length}`);
    console.log(`  page requests ${by('page').length} (${mb(by('page'))} MB); extension refetches ${ext.length} (${mb(ext)} MB, ${ext.filter((r) => r.cached).length} from cache, non-200: ${ext.filter((r) => r.status !== 200).map((r) => r.status).join(',') || 'none'}); ${JSON.stringify(imgs)}`);
    if (ext.length) {
      const hosts = {};
      for (const r of ext) { const h = new URL(r.url).host; hosts[h] = (hosts[h] ?? 0) + 1; }
      console.log('  extension refetch hosts', JSON.stringify(hosts));
    }
  } finally {
    await browser?.close().catch(() => {});
    proc.kill();
  }
}

async function waitForOffscreen(browser) {
  for (let i = 0; i < 40; i++) {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const off = targetInfos.find((t) => t.url.includes('/offscreen/'));
    if (off) {
      return {
        send: (method, params) => rawSend(browser, off.targetId, method, params),
        on: (event, fn) => onTarget(browser, off.targetId, event, fn),
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Simplest reliable route to the offscreen document: a separate raw CDP websocket.
const sockets = new Map();
async function socketFor(targetId) {
  if (sockets.has(targetId)) return sockets.get(targetId);
  const list = await (await fetch(`http://127.0.0.1:${currentPort}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const s = { ws, n: 0, handlers: {} };
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    for (const fn of s.handlers[msg.method] ?? []) fn(msg.params);
  });
  sockets.set(targetId, s);
  return s;
}
async function rawSend(_b, targetId, method, params) {
  const s = await socketFor(targetId);
  s.ws.send(JSON.stringify({ id: ++s.n, method, params }));
}
async function onTarget(_b, targetId, event, fn) {
  const s = await socketFor(targetId);
  (s.handlers[event] ??= []).push(fn);
}

let currentPort = 9333;
for (const withExt of process.env.ONLY_EXT ? [true] : [false, true]) {
  currentPort = withExt ? 9334 : 9333;
  sockets.clear();
  await run(withExt, currentPort);
}

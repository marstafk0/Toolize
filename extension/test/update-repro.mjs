// Reproduces "an extension update freezes the browser": busy tabs open, measure, update
// the extension in place (bumped version + runtime.reload), measure again.
//   node test/update-repro.mjs            (needs a dev build in dist/)
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = join(import.meta.dirname, '..');
// A private copy, so the version can be bumped to fake an update.
const ext = mkdtempSync(join(tmpdir(), 'tz-upd-ext-'));
// OLD_DIST: start from an older build (e.g. a released version) and update to dist/.
cpSync(isolatedDist(process.env.OLD_DIST ?? join(root, 'dist')), ext, { recursive: true });
const manifestPath = join(ext, 'manifest.json');
if (process.env.SMALL_RULES) {
  // Same extension with the big list swapped for a 1,000-domain one: is the list the cost?
  const rulesPath = join(ext, 'rules/adult.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  const big = rules.find((r) => r.id === 1);
  console.log(`small rules: ${big.condition.requestDomains.length} -> 1000 domains`);
  big.condition.requestDomains = big.condition.requestDomains.slice(0, 1000);
  writeFileSync(rulesPath, JSON.stringify(rules));
}

const server = spawn(process.execPath, [join(root, 'scripts/serve-test.mjs')], { stdio: 'ignore' });
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tz-upd-')), {
  executablePath: findChromium(), headless: !process.env.HEADED, viewport: { width: 1280, height: 900 },
  // Playwright adds --disable-extensions by default, which also disables an extension
  // reloaded from the extensions page. Without it the reload behaves like a real update.
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await new Promise((r) => setTimeout(r, 3000));

  const urls = [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://www.reddit.com/r/pics/',
    'http://localhost:8787/pages/index.html',
    'https://www.youtube.com/',
  ];
  const pages = [];
  for (const u of urls) {
    const p = await ctx.newPage();
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    pages.push(p);
  }
  await new Promise((r) => setTimeout(r, 8000));

  // Frame pacing on the front page + how long a fresh navigation takes in another tab.
  const within = (p, ms = 10_000) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT (tab frozen)'), ms))]);
  async function measure(label) {
    const front = pages[2];
    await within(front.bringToFront());
    const frames = await within(front.evaluate(() => new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      const end = last + 3000;
      const step = (t) => {
        gaps.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(step);
        else resolve(gaps);
      };
      requestAnimationFrame(step);
    })).catch((e) => `error: ${e.message}`));
    const t0 = Date.now();
    const nav = await within(pages[1].goto('https://www.reddit.com/r/aww/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .then(() => `${Date.now() - t0} ms`, (e) => `FAILED after ${Date.now() - t0} ms (${e.message.slice(0, 60)})`), 35_000);
    const local = Date.now();
    const nav2 = await within(pages[3].goto('http://localhost:8787/pages/frame.html', { waitUntil: 'load', timeout: 30_000 })
      .then(() => `${Date.now() - local} ms`, (e) => `FAILED (${e.message.slice(0, 60)})`), 35_000);
    const stats = Array.isArray(frames)
      ? (() => {
        const s = [...frames].sort((a, b) => a - b);
        return `frames ${s.length}, p95 ${s[Math.floor(s.length * 0.95)].toFixed(0)} ms, max ${s.at(-1).toFixed(0)} ms`;
      })()
      : frames;
    const frontStates = await within(pages[2].evaluate(() => [...document.querySelectorAll('img,video')].reduce((m, e) => {
      const k = e.getAttribute('data-tz') ?? 'none';
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {})).catch((e) => e.message));
    const states = await within(pages[0].evaluate(() => [...document.querySelectorAll('img,video')].reduce((m, e) => {
      const k = e.getAttribute('data-tz') ?? 'none';
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {})).catch((e) => e.message));
    console.log(`${label.padEnd(18)} ${stats}; reddit nav ${nav}; local nav ${nav2}; youtube tab ${JSON.stringify(states)}; front tab ${JSON.stringify(frontStates)}`);
  }

  await measure('before update');

  if (process.env.OLD_DIST) cpSync(isolatedDist(join(root, 'dist')), ext, { recursive: true });
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.version = m.version.replace(/\d+$/, (n) => String(Number(n) + 1));
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const t0 = Date.now();
  // Exactly what the reload button on the extensions page does.
  const id = new URL(sw.url()).host;
  const extPage = await ctx.newPage();
  extPage.on('console', (msg) => msg.text().startsWith('reload') && console.log('  ' + msg.text()));
  await extPage.goto('chrome://extensions/');
  await extPage.evaluate(async (id) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.reload(id, { failQuietly: true });
  }, id);
  await new Promise((r) => setTimeout(r, 3000));
  console.log('  after reload:', JSON.stringify(await extPage.evaluate(async (id) => {
    const all = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
    return all.map((e) => ({ id: e.id === id, version: e.version, state: e.state, disableReasons: e.disableReasons, errors: e.runtimeErrors?.length, manifestErrors: e.manifestErrors?.map((x) => x.message) }));
  }, id)));
  await extPage.close();
  await new Promise((r) => setTimeout(r, 1500));
  const probe = await ctx.newPage();
  await probe.goto(`chrome-extension://${id}/popup/popup.html`).catch(() => {});
  console.log('  extension version via its popup:', await probe.evaluate(() => chrome.runtime.getManifest().version).catch((e) => e.message.slice(0, 80)));
  await probe.close();
  for (let found = false; !found && Date.now() - t0 < 5_000; ) {
    await new Promise((r) => setTimeout(r, 250));
    for (const w of ctx.serviceWorkers()) {
      const v = await Promise.race([w.evaluate(() => chrome.runtime.getManifest().version).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000))]);
      if (v === m.version) [sw, found] = [w, true];
    }
  }
  console.log(`updated to ${m.version}: new worker after ${Date.now() - t0} ms`);
  for (const w of ctx.serviceWorkers()) {
    console.log('  worker', w.url(), await Promise.race([w.evaluate(() => chrome.runtime.getManifest().version).catch((e) => `dead: ${e.message.slice(0, 80)}`), new Promise((r) => setTimeout(() => r('no answer'), 2000))]));
  }

  for (const at of [2, 10, 30]) {
    await new Promise((r) => setTimeout(r, at === 2 ? 2000 : at === 10 ? 8000 : 20000));
    await measure(`${at}s after update`);
  }
  // A background tab is revived when it's looked at.
  const revive = () => within(sw.evaluate(async () => ({
    pending: (await chrome.storage.session.get('reviveTabs')).reviveTabs,
    tabs: (await chrome.tabs.query({})).map((t) => `${t.id}:${t.active ? 'A' : '-'}:${(t.url ?? '').slice(0, 40)}`),
  })));
  console.log('revive before switch', JSON.stringify(await revive()));
  await pages[0].bringToFront();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('revive after switch', JSON.stringify(await revive()));
  await new Promise((r) => setTimeout(r, 10_000));
  console.log('youtube tab after switching to it', JSON.stringify(await within(pages[0].evaluate(() => [...document.querySelectorAll('img,video')].reduce((m, e) => {
    const k = e.getAttribute('data-tz') ?? 'none';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {})))));
} finally {
  await ctx.close();
  server.kill();
}

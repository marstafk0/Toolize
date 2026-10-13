// What installing (or updating) the extension costs the browser, by blocklist size:
// time until the extension is up, and the browser's memory afterwards.
//   node test/load-cost.mjs [domains...]     e.g. node test/load-cost.mjs 1000 19000 all
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const dist = isolatedDist(join(import.meta.dirname, '../dist'));
for (const size of process.argv.slice(2)) {
  const ext = mkdtempSync(join(tmpdir(), 'tz-cost-'));
  cpSync(dist, ext, { recursive: true });
  const rulesPath = join(ext, 'rules/adult.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  const big = rules.find((r) => r.id === 1);
  if (size !== 'all') big.condition.requestDomains = big.condition.requestDomains.slice(0, Number(size));
  writeFileSync(rulesPath, JSON.stringify(rules));

  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tz-cost-p-')), {
    executablePath: findChromium(), headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 120_000 }));
  // Up = the ruleset is live and a blocked domain is actually redirected.
  const page = await ctx.newPage();
  const probe = big.condition.requestDomains[0];
  let blockedAt = null;
  for (let i = 0; i < 240 && !blockedAt; i++) {
    await page.goto(`http://${probe}/`, { timeout: 5000 }).catch(() => {});
    if (page.url().includes('/blocked/')) blockedAt = Date.now() - t0;
    else await new Promise((r) => setTimeout(r, 250));
  }
  const cdp = await ctx.browser()?.newBrowserCDPSession?.().catch(() => null);
  let mem = 'n/a';
  if (cdp) {
    const info = await cdp.send('SystemInfo.getProcessInfo').catch(() => null);
    if (info) mem = `${info.processInfo.length} processes`;
  }
  console.log(`${String(big.condition.requestDomains.length).padStart(7)} domains: worker up ${Date.now() - t0 - (blockedAt ? 0 : 0)} ms after launch, blocking live ${blockedAt ?? 'never'} ms; ${sw ? 'ok' : ''} ${mem}`);
  await ctx.close();
}

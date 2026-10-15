// Headless corpus regression: runs the corpus page (dev build) over test/corpus and
// prints false-positive / false-negative rates per preset. Full report (per-image
// scores) is saved to test/corpus/results/<timestamp>.json by the test server.
//
//   npm run corpus
//   HEADED=1 npm run corpus    (also shows misclassified thumbnails)
//   MODEL=inception_v3 npm run corpus   (compare another NSFWJS model)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = isolatedDist(join(root, 'dist'));
const server = spawn(process.execPath, [join(root, 'scripts/serve-test.mjs')], { stdio: ['ignore', 'inherit', 'inherit'] });
const profile = mkdtempSync(join(tmpdir(), 'bb-corpus-'));
let context;
let code = 0;
try {
  await new Promise((r) => setTimeout(r, 500));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/corpus/corpus.html?server=http://localhost:8787${process.env.MODEL ? `&model=${process.env.MODEL}` : ''}`);
  await page.waitForFunction(() => window.__corpusDone, null, { timeout: 30 * 60_000, polling: 500 });
  const r = await page.evaluate(() => window.__corpusDone);

  if (r.error) throw new Error(r.error);
  if (r.empty) {
    console.log('Corpus is empty. Add images under test/corpus/safe/<category>/ and test/corpus/flag/<category>/ (see test/corpus/README.md).');
  } else {
    console.log(`\n${r.total} images (${r.failed} failed to load) in ${r.seconds.toFixed(1)}s on ${r.backend}\n`);
    const presets = Object.keys(r.rows[0].wrong);
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('set', 34) + pad('n', 6) + pad('', 4) + presets.map((p) => pad(p, 16)).join(''));
    for (const row of r.rows) {
      const cells = presets.map((p) => pad(`${row.wrong[p]} (${row.n ? ((100 * row.wrong[p]) / row.n).toFixed(1) : '–'}%)`, 16));
      console.log(pad(row.name, 34) + pad(row.n, 6) + pad(row.kind, 4) + cells.join(''));
    }
  }
  if (process.env.HEADED) await page.waitForEvent('close', { timeout: 0 });
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await context?.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);

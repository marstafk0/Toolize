// Contact sheet of a corpus folder, numbered, for reviewing labels at a glance. Images
// already in test/corpus/exclude.txt are left out; --new shows only files newer than
// the exclude list (i.e. fetched since the last review).
//   node scripts/corpus-sheet.mjs test/corpus/flag/swimwear out.png [--new]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium } from '../test/chromium.mjs';

const [dir, out] = process.argv.slice(2);
const corpus = resolve(import.meta.dirname, '../test/corpus');
const excludeFile = join(corpus, 'exclude.txt');
const excluded = new Set(existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
const since = process.argv.includes('--new') && existsSync(excludeFile) ? statSync(excludeFile).mtimeMs : 0;
const files = readdirSync(dir)
  .sort()
  .filter((f) => !excluded.has(relative(corpus, resolve(dir, f)).split(sep).join('/')))
  .filter((f) => statSync(join(dir, f)).mtimeMs > since);
const html = `<body style="margin:0;display:grid;grid-template-columns:repeat(10,160px);gap:2px;font:9px sans-serif">${files
  .map((f) => `<div><img src="${pathToFileURL(resolve(dir, f))}" style="width:160px;height:120px;object-fit:cover;display:block">${f.slice(0, 30)}</div>`)
  .join('')}</body>`;
const page = join(tmpdir(), 'tz-corpus-sheet.html');
writeFileSync(page, html);
const browser = await chromium.launch({ executablePath: findChromium() });
const pg = await browser.newPage({ viewport: { width: 1620, height: 800 } });
await pg.goto(pathToFileURL(page).href);
await pg.waitForLoadState('networkidle');
await pg.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`${files.length} images -> ${out}`);

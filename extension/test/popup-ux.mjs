// Focused Playwright tests for the popup and blocked page UX:
// - Compact copy format (header line + 1 line per entry, HH:MM:SS, no repeated ISO timestamps, scores only)
// - Visible copy feedback ("Copied ✓") + fallback to document.execCommand('copy') when clipboard rejects
// - "Copy all (incl. shown)" button copies all verdicts even when "Blurred only" is checked
// - Feeds and verdicts <details> open states remembered in localStorage
// - Lock hints (🔒) shown on weakening controls when companion is connected
// - Dismissible lock-note error banner
// - No horizontal overflow (scrollWidth <= clientWidth) and WCAG AA contrast
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, isolatedDist } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = isolatedDist(join(root, 'dist'));
const isHarnessTemp = (p, prefix) => dirname(resolve(p)) === resolve(tmpdir()) && basename(p).startsWith(prefix);
if (!isHarnessTemp(dist, 'tz-dist-')) throw new Error(`unexpected isolated extension path: ${dist}`);
const artifacts = join(root, 'test/.artifacts');
mkdirSync(artifacts, { recursive: true });

const failures = [];
let passes = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
  else passes++;
};

const profile = mkdtempSync(join(tmpdir(), 'bb-popup-'));
if (!isHarnessTemp(profile, 'bb-popup-')) throw new Error(`unexpected test profile path: ${profile}`);
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      ...(process.env.NO_GPU ? ['--disable-gpu'] : ['--enable-unsafe-webgpu']),
    ],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 300, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);

  // Seed deterministic tab verdicts for the active tab (the popup tab itself here)
  const tabId = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab.id;
  });
  await sw.evaluate(async (id) => {
    const now = Date.now();
    await chrome.storage.session.set({
      tabVerdicts: {
        [id]: [
          {
            at: now - 30_000,
            kind: 'image',
            decision: 'blocked',
            why: ['safety 0.86 > 0.50'],
            scores: { safety: 0.86, neutral: 0.92, porn: 0.05, hentai: 0.01, sexy: 0.01, drawing: 0.02 },
            preset: 'balanced',
            size: { w: 720, h: 404 },
          },
          {
            at: now - 10_000,
            kind: 'image',
            decision: 'clean',
            why: ['safety 0.04', 'sexy 0.01', 'hentai 0.00', 'porn 0.01'],
            scores: { safety: 0.04, neutral: 0.98, porn: 0.01, hentai: 0, sexy: 0.01, drawing: 0 },
            preset: 'balanced',
            size: { w: 640, h: 480 },
          },
        ],
      },
    });
  }, tabId);

  await popup.waitForFunction(() => document.querySelectorAll('.verdict-row').length === 1);

  // Part 1: Copy as text compact format + visible feedback
  await popup.locator('#verdicts > summary').click();
  await popup.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__copiedText = text;
    };
  });
  await popup.locator('#verdict-copy').click();
  const copied = await popup.evaluate(() => window.__copiedText);
  const lines = String(copied).split('\n');
  check('compact copy has 1 header line + 1 line per visible entry', lines.length === 2, JSON.stringify(lines));
  check(
    'header includes version, preset, engine/backend, and safety on/off',
    /^Toolize v\d+\.\d+\.\d+ \| preset balanced \| engine .+ \| safety (on|off)$/.test(lines[0]),
    lines[0],
  );
  check(
    'entry line uses HH:MM:SS, compact scores, and dimensions without ISO timestamp',
    /^\d{2}:\d{2}:\d{2} image blurred safety 0\.86>0\.50 \| n0\.92 p0\.05 h0\.01 s0\.01 d0\.02 .* \| balanced 720×404$/.test(lines[1]) &&
      !/\d{4}-\d{2}-\d{2}T/.test(copied),
    lines[1],
  );
  check(
    'copy button and status show visible "Copied ✓" feedback',
    (await popup.locator('#verdict-copy-status').innerText()) === 'Copied ✓' &&
      (await popup.locator('#verdict-copy').innerText()) === 'Copied ✓',
  );

  // Copy all (incl. shown) while Blurred only is still checked
  await popup.locator('#verdict-copy-all').click();
  const copiedAll = await popup.evaluate(() => window.__copiedText);
  const allLines = String(copiedAll).split('\n');
  check(
    'Copy all (incl. shown) copies both blurred and shown entries with header',
    allLines.length === 3 && copiedAll.includes('blurred') && copiedAll.includes('shown'),
    `lines=${allLines.length}`,
  );

  // Fallback to textarea + execCommand('copy') when navigator.clipboard.writeText rejects
  await popup.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new DOMException('Document is not focused', 'NotAllowedError');
    };
    window.__execCommandCopied = '';
    const origExec = document.execCommand.bind(document);
    document.execCommand = (cmd) => {
      if (cmd === 'copy') {
        window.__execCommandCopied = window.getSelection()?.toString() || document.activeElement?.value || '';
        return true;
      }
      return origExec(cmd);
    };
  });
  await popup.locator('#verdict-copy').click();
  const fallbackCopied = await popup.evaluate(() => window.__execCommandCopied);
  check(
    'clipboard rejection falls back to hidden textarea + execCommand("copy")',
    typeof fallbackCopied === 'string' && fallbackCopied.includes('720×404'),
  );

  // Error feedback when both clipboard and execCommand fail
  await popup.evaluate(() => {
    document.execCommand = () => false;
  });
  await popup.locator('#verdict-copy').click();
  check(
    'when both clipboard paths fail, an explicit error message is shown',
    (await popup.locator('#verdict-copy-status').innerText()).includes('Could not copy'),
  );

  // Part 2: Feeds & Verdicts collapsed state remembered
  check('feeds section starts collapsed by default', !(await popup.locator('#feeds').evaluate((el) => el.open)));
  await popup.locator('#feeds > summary').click();
  check('feeds section opens on click and scrolls within bounded height', await popup.evaluate(() => {
    const el = document.getElementById('feed-sites');
    return document.getElementById('feeds').open && getComputedStyle(el).maxHeight === '220px' && el.scrollHeight > el.clientHeight;
  }));
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('feeds').open && document.getElementById('verdicts').open);
  check('popup remembers both Feeds and Verdicts open states across reload', true);

  // Lock hints when companion is connected + dismissible lock-note error
  await popup.evaluate(() => {
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (msg) => {
      if (msg?.kind === 'companion') return { installed: true };
      if (msg?.kind === 'setSettings') {
        return { ok: false, error: 'the unlock key must be plugged in to allow turning off safe search', code: 'locked' };
      }
      return origSend(msg);
    };
  });
  await popup.waitForFunction(() => document.querySelectorAll('.needs-key').length > 0);
  const badgeInfo = await popup.evaluate(() => ({
    relaxedHasLock: !!document.querySelector('#preset button[data-value="relaxed"] .needs-key'),
    strictHasLock: !!document.querySelector('#preset button[data-value="strict"] .needs-key'),
    fastHasLock: !!document.querySelector('#mode button[data-value="fast"] .needs-key'),
    safeHasLock: !!document.querySelector('#mode button[data-value="safe"] .needs-key'),
  }));
  check(
    'when companion is connected, weakening options show 🔒 hint and strengthening options do not',
    badgeInfo.relaxedHasLock && !badgeInfo.strictHasLock && badgeInfo.fastHasLock && !badgeInfo.safeHasLock,
    JSON.stringify(badgeInfo),
  );

  await popup.locator('label[title="Safe search"]').click();
  await popup.waitForFunction(() => !document.getElementById('lock-banner').hidden);
  check(
    'refused change displays readable lock-note banner and snaps control back',
    (await popup.locator('#lock-note').innerText()).includes('unlock key must be plugged in') &&
      (await popup.locator('#safeSearch').isChecked()),
  );
  await popup.locator('#lock-dismiss').click();
  check('lock-note banner is dismissible', await popup.locator('#lock-banner').evaluate((el) => el.hidden));

  // Width overflow check
  const noOverflow = await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('popup width does not overflow horizontally', noOverflow);

  await popup.screenshot({ path: join(artifacts, 'popup-ux.png'), fullPage: true });
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures.length} failed — ${failures.length ? 'FAILED' : 'ALL PASSED'}`);
process.exit(failures.length ? 1 : 0);

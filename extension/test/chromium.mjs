import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Chromium binary for tests. Branded Google Chrome (137+) ignores --load-extension, so
 * use Playwright's Chromium: $CHROMIUM, else the newest one in the Playwright cache,
 * else undefined (playwright-core resolves its own; `npx playwright install chromium`).
 */
export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library/Caches/ms-playwright')
        : join(homedir(), '.cache/ms-playwright'));
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  const bins = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const d of dirs) {
    for (const rel of bins) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * A copy of the built extension without the nativeMessaging permission. With it, a
 * machine that has the Toolize app installed connects the test browser to the real
 * service, which pushes its own settings over the ones the test set — every result
 * then reflects that machine's settings, not the test's.
 */
export function isolatedDist(dist) {
  const copy = mkdtempSync(join(tmpdir(), 'tz-dist-'));
  cpSync(dist, copy, { recursive: true });
  const manifestPath = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = (manifest.permissions ?? []).filter((p) => p !== 'nativeMessaging');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return copy;
}

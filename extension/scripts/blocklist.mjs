// Adult-domain blocklist: OISD NSFW (https://oisd.nl, GPL-3.0), about half a million
// domains, maintained daily under the motto "Block. Don't break."
//
//   node scripts/blocklist.mjs        download the current list into blocklist/
//
// The build bakes it into the declarativeNetRequest ruleset; release builds refresh it
// first so every release ships the latest. Between releases the extension fetches the
// same URL once a day and applies the difference (background/blocklist.ts), so new
// sites are blocked within a day without a store review.
//
// The file is not committed: it is ~8MB and changes every day.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKLIST_URL = 'https://nsfw.oisd.nl/domainswild2';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCKLIST_FILE = join(root, 'blocklist', 'oisd-nsfw.txt');

/** Parses the list format: one domain per line, '#' comments. Rejects anything malformed. */
export function parseBlocklist(text) {
  const domains = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(line)) continue;
    domains.push(line);
  }
  return domains;
}

export async function downloadBlocklist() {
  const res = await fetch(BLOCKLIST_URL);
  if (!res.ok) throw new Error(`blocklist download failed: HTTP ${res.status}`);
  const text = await res.text();
  const domains = parseBlocklist(text);
  // A truncated or hijacked download must not silently shrink protection.
  if (domains.length < 100_000) throw new Error(`blocklist looks wrong: only ${domains.length} domains`);
  mkdirSync(dirname(BLOCKLIST_FILE), { recursive: true });
  writeFileSync(BLOCKLIST_FILE, text);
  return domains.length;
}

export function readBlocklist() {
  return existsSync(BLOCKLIST_FILE) ? parseBlocklist(readFileSync(BLOCKLIST_FILE, 'utf8')) : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = await downloadBlocklist();
  console.log(`blocklist: ${n.toLocaleString()} domains -> ${BLOCKLIST_FILE}`);
}

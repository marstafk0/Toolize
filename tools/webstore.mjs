// Builds the zip to upload to the Chrome Web Store dashboard.
//
//   node tools/webstore.mjs
//
// The store assigns its own extension ID from its own key, so the "key" field that
// pins our self-hosted ID is stripped here. Once the item is created, put the ID the
// dashboard shows into version.json as "storeExtensionId" and cut a release: the
// installer then allows BOTH ids to talk to the service, so a store-installed extension
// and an unpacked dev build both work.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './crx.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
const staging = join(root, 'out', 'webstore');
const target = join(root, 'out', `toolize-webstore-${version}.zip`);

execFileSync(process.execPath, [join(root, 'extension/build.mjs')], { cwd: join(root, 'extension'), stdio: 'inherit' });

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(join(root, 'extension/dist'), staging, { recursive: true });

const manifestPath = join(staging, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
delete manifest.key; // the store supplies the identity
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

writeFileSync(target, zipDirectory(staging));
console.log(`\n${target}`);
console.log(`\nUpload that at https://chrome.google.com/webstore/devconsole, set visibility to Unlisted.`);
console.log('Notes for the listing form:');
console.log('  • Single purpose: filter explicit imagery in pages the user visits.');
console.log('  • host_permissions <all_urls>: the classifier must see images on any site the user opens.');
console.log('  • nativeMessaging: reads settings from the Toolize desktop app, which holds them.');
console.log('  • No data leaves the machine; the model is bundled and runs locally.');

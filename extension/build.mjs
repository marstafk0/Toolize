// Build: esbuild bundles + static files + model extraction.
//   node build.mjs           production build -> dist/
//   node build.mjs --dev     + test hooks (__DEV__) and the corpus regression page
//   node build.mjs --watch   rebuild on change (implies --dev)
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from './scripts/png.mjs';
import { downloadBlocklist, readBlocklist } from './scripts/blocklist.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---- static files
cpSync(join(root, 'static'), out, { recursive: true, filter: (src) => dev || !src.includes('corpus') });
mkdirSync(join(out, 'content'), { recursive: true });
cpSync(join(root, 'src/shared/blur.css'), join(out, 'content/blur.css'));

// ---- manifest: stamp the repo-wide version, and pin the extension ID by embedding the
// packing key's public half. Without this an unpacked dev build gets a random ID, which
// breaks the native messaging allowlist and the update URL.
{
  const manifestPath = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = JSON.parse(readFileSync(join(root, '../version.json'), 'utf8')).version;
  try {
    const { crxPublicKeyBase64 } = await import('../tools/keys.mjs');
    manifest.key = crxPublicKeyBase64();
  } catch {
    console.warn('no signing key yet (run `node tools/keys.mjs`) — building with a random extension ID');
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// ---- model: nsfwjs ships its weights as base64 inside UMD JS modules (and decodes
// them with Node's Buffer). Unpack once into a normal model.json + .bin so TF.js loads
// it straight from the extension package — faster startup, no 3.5 MB of base64 to parse.
{
  const require = createRequire(import.meta.url);
  const pkg = join(root, 'node_modules/nsfwjs/dist/models/mobilenet_v2');
  const modelJson = require(join(pkg, 'model.min.js'));
  const [group] = modelJson.weightsManifest;
  if (modelJson.weightsManifest.length !== 1 || group.paths.length !== 1) throw new Error('unexpected nsfwjs model layout');
  const weights = Buffer.from(require(join(pkg, `${group.paths[0]}.min.js`)), 'base64');
  const binName = `${group.paths[0]}.bin`;
  const dest = join(out, 'models/mobilenet_v2');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, binName), weights);
  writeFileSync(
    join(dest, 'model.json'),
    JSON.stringify({ ...modelJson, weightsManifest: [{ ...group, paths: [binName] }] }),
  );
}

// ---- declarativeNetRequest ruleset for known adult sites. Generated from the same
// source the content script uses, so the list can't drift between the two.
{
  const tmp = join(out, '.sites.mjs');
  await esbuild.build({ entryPoints: [join(root, 'src/shared/sites.ts')], outfile: tmp, bundle: true, format: 'esm', logLevel: 'silent' });
  const { ADULT_DOMAINS, NEVER_BLOCK, adultHostRegexes } = await import(pathToFileURL(tmp).href);
  rmSync(tmp);

  // The big list. Release builds refresh it first; otherwise use the copy on disk, and
  // download one if there is none. A production build without it would ship a
  // protection gap, so that fails; a dev build carries on with the seed list.
  let big = readBlocklist();
  if (!big) {
    try {
      await downloadBlocklist();
      big = readBlocklist();
    } catch (e) {
      if (!dev) throw e;
      console.warn(`blocklist unavailable (${e.message}); dev build uses the seed list only`);
    }
  }
  const never = new Set(NEVER_BLOCK);
  const domains = [...new Set([...ADULT_DOMAINS, ...(big ?? [])])].filter((d) => !never.has(d)).sort();
  console.log(`blocklist: ${domains.length.toLocaleString()} domains`);

  // One rule for every resource type: a navigation lands on the blocked page, an
  // embedded frame shows it inline, and an image/video/XHR redirected to an HTML page
  // simply fails. (One rule also means the list is stored once, not twice.)
  const blocked = { type: 'redirect', redirect: { extensionPath: '/blocked/blocked.html' } };
  const rules = [
    {
      id: 1, priority: 2, action: blocked,
      condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame', 'image', 'media', 'xmlhttprequest'] },
    },
    // Long tail: hostname keyword match (STRONG_WORDS / WEAK_WORDS), several small rules.
    ...adultHostRegexes().map((regexFilter, i) => ({
      id: 3 + i, priority: 1, action: blocked, condition: { regexFilter, resourceTypes: ['main_frame'] },
    })),
  ];
  if (dev) rules.push({ id: 99, priority: 3, action: blocked, condition: { urlFilter: '__tz_test_adult', resourceTypes: ['main_frame'] } });
  mkdirSync(join(out, 'rules'), { recursive: true });
  writeFileSync(join(out, 'rules/adult.json'), JSON.stringify(rules));
  writeFileSync(
    join(out, 'rules/NOTICE.txt'),
    'rules/adult.json includes the OISD NSFW list (https://oisd.nl), licensed under the GNU GPL v3.\n' +
      'The extension refreshes it daily from https://nsfw.oisd.nl/domainswild2.\n',
  );
}

// ---- TF.js WASM backend binaries (fallback when there's no hardware WebGL).
// Threaded build omitted: needs cross-origin isolation of the offscreen doc.
{
  const wasmSrc = join(root, 'node_modules/@tensorflow/tfjs-backend-wasm/dist');
  mkdirSync(join(out, 'wasm'), { recursive: true });
  for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm']) cpSync(join(wasmSrc, f), join(out, 'wasm', f));
}

// ---- icons: accent disc with a "blurred" bar
{
  mkdirSync(join(out, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const c = (size - 1) / 2;
    const png = encodePng(size, size, (x, y) => {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      if (d > 1) return [0, 0, 0, 0];
      const edge = Math.min(1, (1 - d) * size * 0.5); // cheap anti-aliasing
      const bar = Math.abs(y - c) < size * 0.1 && Math.abs(x - c) < size * 0.3;
      return bar ? [255, 255, 255, 255 * edge] : [47, 93, 80, 255 * edge];
    });
    writeFileSync(join(out, `icons/${size}.png`), png);
  }
}

// ---- bundles
const common = {
  bundle: true,
  target: 'chrome116',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { __DEV__: String(dev) },
  loader: { '.css': 'text' },
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    format: 'esm',
    entryPoints: {
      background: 'src/background/index.ts',
      'offscreen/offscreen': 'src/offscreen/index.ts',
      ...(dev ? { 'corpus/corpus': 'src/corpus/index.ts' } : {}),
    },
    outdir: out,
  },
  {
    ...common,
    format: 'iife',
    entryPoints: {
      'content/content': 'src/content/index.ts',
      'content/main-world': 'src/content/main-world.ts',
      'popup/popup': 'src/popup/index.ts',
      'blocked/blocked': 'src/blocked/index.ts',
    },
    outdir: out,
  },
];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log(`built ${dev ? 'dev' : 'production'} extension -> ${out}`);
}

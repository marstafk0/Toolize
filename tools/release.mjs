// Cuts a release: builds everything, signs the manifest, publishes to GitHub Releases.
//
//   node tools/release.mjs --channel dev            build + publish a dev release
//   node tools/release.mjs --channel stable 0.4.0   bump the version first
//   node tools/release.mjs --channel dev --local    build only, publish nothing
//
// Installed machines see the new version through the app's Update button: the service
// fetches update-<channel>.json, checks its signature against the baked-in public key,
// checks the installer's SHA-256, and only then runs it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCrx } from './crx.mjs';
import { extensionId, signRelease } from './keys.mjs';
import { stamp } from './stamp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const args = process.argv.slice(2);
const channel = args[args.indexOf('--channel') + 1] ?? 'dev';
const local = args.includes('--local');
const newVersion = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!['dev', 'stable'].includes(channel)) throw new Error(`unknown channel "${channel}"`);

const run = (cmd, cmdArgs, cwd = root) => {
  console.log(`  $ ${basename(cmd)} ${cmdArgs.join(' ')}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' });
};

const dotnet = process.env.DOTNET ?? 'C:\\Program Files\\dotnet\\dotnet.exe';
const iscc = process.env.ISCC ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe');

// ---------------------------------------------------------------- build

const { version, repo } = stamp(newVersion);
const tag = channel === 'dev' ? `v${version}-dev` : `v${version}`;
const assetUrl = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
const names = {
  installer: `Toolize-${version}.exe`,
  crx: `toolize-${version}.crx`,
  updateXml: `update-${channel}.xml`,
  manifest: `update-${channel}.json`,
};

console.log(`\nToolize ${version} (${channel}) -> ${tag}\n`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('building extension…');
run(process.execPath, [join(root, 'extension/build.mjs')], join(root, 'extension'));
const crx = packCrx(join(root, 'extension/dist'), join(out, names.crx));
console.log(`  packed ${names.crx} (${(crx.bytes / 1e6).toFixed(2)} MB), id ${crx.id}`);

console.log('publishing companion…');
const appDir = join(out, 'app');
for (const project of ['Toolize.Service', 'Toolize.Gui', 'Toolize.Cli', 'Toolize.NativeHost']) {
  run(dotnet, [
    'publish', join(root, 'companion', project, `${project}.csproj`),
    '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
    // Not single-file: all four publish into one folder so the .NET runtime ships once
    // instead of four times (117 MB -> ~40 MB installer).
    '-p:DebugType=none', '-p:SatelliteResourceLanguages=en',
    '-o', appDir,
  ]);
}

// The installer picks the extension up from out/extension.
run(process.execPath, ['-e', `require('fs').cpSync(${JSON.stringify(join(root, 'extension/dist'))}, ${JSON.stringify(join(out, 'extension'))}, {recursive:true})`]);

console.log('building installer…');
if (!existsSync(iscc)) throw new Error(`Inno Setup not found at ${iscc} (set ISCC=...)`);
run(iscc, [
  `/DAppVersion=${version}`,
  `/DExtId=${extensionId()}`,
  `/DUpdateXmlUrl=${assetUrl(names.updateXml)}`,
  `/DSourceDir=${appDir}`,
  join(root, 'installer/toolize.iss'),
]);

// ---------------------------------------------------------------- manifests

const installerPath = join(out, names.installer);
const installerSha = createHash('sha256').update(readFileSync(installerPath)).digest('hex');

// Chrome's own update protocol, for the extension.
writeFileSync(
  join(out, names.updateXml),
  `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${extensionId()}'>
    <updatecheck codebase='${assetUrl(names.crx)}' version='${version}' />
  </app>
</gupdate>
`,
);

// Ours, for the app. Signed — this is the only thing standing between the update
// channel and arbitrary code on every installed machine.
const manifest = {
  version,
  channel,
  notes: process.env.RELEASE_NOTES ?? `Toolize ${version}`,
  installerUrl: assetUrl(names.installer),
  installerSha256: installerSha,
  extensionVersion: version,
  crxUrl: assetUrl(names.crx),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(join(out, names.manifest), manifestBytes);
writeFileSync(join(out, `${names.manifest}.sig`), signRelease(manifestBytes));
console.log(`  installer sha256 ${installerSha}`);

if (local) {
  console.log(`\nbuilt locally in ${out} — nothing published (--local)`);
  process.exit(0);
}

// ---------------------------------------------------------------- publish

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
}).match(/^password=(.+)$/m)?.[1];
if (!token) throw new Error('no GitHub credential found — run `git push` once to store one');

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'toolize-release',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  return response.json();
};

console.log(`publishing ${tag}…`);
const existing = await api(`/repos/${repo}/releases`).then((rs) => rs.find((r) => r.tag_name === tag));
if (existing) {
  console.log('  replacing the existing release of this tag');
  await api(`/repos/${repo}/releases/${existing.id}`, { method: 'DELETE' });
}

const release = await api(`/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify({
    tag_name: tag,
    name: `Toolize ${version}${channel === 'dev' ? ' (dev)' : ''}`,
    body: manifest.notes,
    prerelease: channel === 'dev',
    target_commitish: 'main',
  }),
});

for (const name of Object.values(names).concat(`${names.manifest}.sig`)) {
  const body = readFileSync(join(out, name));
  console.log(`  uploading ${name} (${(body.length / 1e6).toFixed(2)} MB)`);
  const upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'user-agent': 'toolize-release',
    },
    body,
  });
  if (!upload.ok) throw new Error(`upload ${name} failed: ${upload.status} ${await upload.text()}`);
}

console.log(`\npublished ${release.html_url}`);
console.log('Installed machines will offer this from the Update button.');

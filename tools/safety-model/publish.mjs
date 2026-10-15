// Publishes a trained safety model as a GitHub release asset and pins it in
// extension/models/safety.json (URL, SHA-256, size), which extension/build.mjs reads.
//   node tools/safety-model/publish.mjs <model.onnx> <version, e.g. v1>
// The release has no update manifest, so the app's updater ignores it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [file, version] = process.argv.slice(2);
if (!file || !/^v\d+$/.test(version ?? '')) throw new Error('usage: publish.mjs <model.onnx> v<N>');
const root = join(import.meta.dirname, '../..');
const { repo } = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
const body = readFileSync(file);
const sha256 = createHash('sha256').update(body).digest('hex');
const tag = `safety-model-${version}`;
const name = `safety-${version}.onnx`;

const token = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  .match(/^password=(.+)$/m)?.[1];
if (!token) throw new Error('no GitHub credential found — run `git push` once to store one');
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'toolize-release' };
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

const existing = await api(`/repos/${repo}/releases/tags/${tag}`).catch(() => null);
if (existing) throw new Error(`${tag} already exists — models are immutable once pinned; publish a new version`);
const release = await api(`/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify({
    tag_name: tag,
    name: `Safety model ${version}`,
    body: `Image safety model for the Toolize extension (see tools/safety-model/README.md).\nSHA-256: ${sha256}`,
    target_commitish: 'main',
    make_latest: 'false',
  }),
});
console.log(`uploading ${name} (${(body.length / 1e6).toFixed(1)} MB)…`);
const up = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${name}`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/octet-stream' },
  body,
});
if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
const asset = await up.json();

const pinFile = join(root, 'extension/models/safety.json');
const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
Object.assign(pin, { version: `safety-${version}`, url: asset.browser_download_url, sha256, size: body.length });
writeFileSync(pinFile, JSON.stringify(pin, null, 2) + '\n');
// Seed the build cache so the next build doesn't download what's already here.
mkdirSync(join(root, 'extension/.cache'), { recursive: true });
writeFileSync(join(root, 'extension/.cache', `safety-${sha256.slice(0, 16)}.onnx`), body);
console.log(`published ${release.html_url}\npinned in extension/models/safety.json`);

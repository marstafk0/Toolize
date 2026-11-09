// Numeric synthetic scores only. Exercises the actual sampler/window and pause path.
// node --test test/video-policy.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const temporary = mkdtempSync(join(tmpdir(), 'tz-video-policy-'));
if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('tz-video-policy-')) {
  throw new Error(`unexpected test directory: ${temporary}`);
}
after(() => rmSync(temporary, { recursive: true, force: true }));
const entry = join(temporary, 'policy.mjs');
await esbuild.build({
  stdin: {
    contents: "export * from './shared/policy'; export { VideoWatcher } from './content/video';",
    resolveDir: join(import.meta.dirname, '../src'),
  },
  outfile: entry, bundle: true, format: 'esm', define: { __DEV__: 'false' }, logLevel: 'silent',
});
const { PRESETS, isObviouslyExplicit, VideoWatcher } = await import(pathToFileURL(entry).href);
const scores = (safety, porn = 0, hentai = 0, sexy = 0) => ({
  safety, whole: { porn, hentai, sexy, neutral: 1 - porn - hentai - sexy, drawing: 0 }, width: 448, height: 252,
});

test('safety alone is never obvious, including scores near one in every preset', () => {
  for (const th of Object.values(PRESETS)) for (const safety of [0.6, 0.9, 0.95, 0.97, 0.99, 1]) {
    assert.equal(isObviouslyExplicit(scores(safety), th), false);
    assert.equal(isObviouslyExplicit(scores(0.99, 0.99), th), true);
  }
});

test('immediate safety trigger requires high confidence and NSFWJS agreement', () => {
  assert.equal(isObviouslyExplicit(scores(0.97, 0.4), PRESETS.balanced), false);
  assert.equal(isObviouslyExplicit(scores(0.99, 0.55), PRESETS.balanced), false);
  assert.equal(isObviouslyExplicit(scores(0.99, 0.55001), PRESETS.balanced), true);
  assert.equal(isObviouslyExplicit(scores(0.99, 0.1, 0.1, 0.11), PRESETS.balanced), false);
  // An ordinary music frame measured 0.996 safety / 0.395 porn: both models
  // must actually flag, rather than accepting a low sum of NSFWJS probabilities.
  assert.equal(isObviouslyExplicit(scores(0.995695, 0.3952, 0.025, 0.0213), PRESETS.balanced), false);
  assert.equal(isObviouslyExplicit(scores(0.99, 0, 0, 0.76), PRESETS.balanced), true);
  assert.equal(isObviouslyExplicit(scores(undefined, 0.99), PRESETS.balanced), true);
  assert.equal(isObviouslyExplicit(scores(undefined, 0, 0.99), PRESETS.balanced), true);
});

// Minimal browser surface, with classification returning supplied numeric results.
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'synthetic-frame' }) };
globalThis.location = { hostname: 'ordinary.example' };
function sampler({ shown = false, paused = false, preset = 'balanced' } = {}) {
  let result = scores(0.01);
  const stamps = [];
  const rows = [];
  const watcher = new VideoWatcher({ classifyFrame: async () => result }, { set: (_, s) => stamps.push(s) }, { record: (...r) => rows.push(r) });
  watcher.settings = { enabled: true, preset };
  const video = { paused, currentTime: 1, duration: 100, videoWidth: 448, videoHeight: 252, hasAttribute: () => false, pause() { this.paused = true; } };
  const track = { recent: [], cleanStreak: 0, every: 1000, generation: 0, failures: 0, ...(shown ? { verdict: 'clean' } : {}) };
  watcher.tracks.set(video, track);
  return { track, video, rows, stamps, async sample(r) { result = r; video.currentTime++; await watcher.sample(video); } };
}

test('shown playing video tolerates one safety-only spike, then still catches two of three', async () => {
  const s = sampler({ shown: true });
  await s.sample(scores(0.01));
  await s.sample(scores(0.95));
  assert.equal(s.track.verdict, 'clean');
  assert.equal(s.video.paused, false);
  await s.sample(scores(0.01));
  await s.sample(scores(0.95));
  assert.equal(s.track.verdict, 'blocked');
  assert.equal(s.video.paused, true);
  assert.match(s.rows.at(-1).at(-1), /2 flagged/);
});

test('corroborated explicit frame immediately blocks and pauses a shown video', async () => {
  const s = sampler({ shown: true });
  await s.sample(scores(0.99, 0.99));
  assert.equal(s.track.verdict, 'blocked');
  assert.equal(s.video.paused, true);
  assert.equal(s.track.recent.length, 1);
});

test('borderline safety alone reveals a new preview, NSFWJS agreement retains safe reveal', async () => {
  const s = sampler();
  await s.sample(scores(0.6));
  assert.equal(s.track.verdict, 'clean');
  const agreed = sampler();
  await agreed.sample(scores(0.6, 0.6));
  assert.equal(agreed.track.verdict, 'blocked');
  assert.equal(agreed.video.paused, false);
  await agreed.sample(scores(0.01));
  await agreed.sample(scores(0.01));
  assert.equal(agreed.track.verdict, 'blocked');
  await agreed.sample(scores(0.01));
  assert.equal(agreed.track.verdict, 'clean');
});

test('strong safety-only first frame remains hidden and repeated high scores pause', async () => {
  const s = sampler();
  await s.sample(scores(0.95));
  assert.equal(s.track.verdict, 'blocked');
  assert.equal(s.video.paused, false);
  await s.sample(scores(0.95));
  assert.equal(s.video.paused, true);
});

test('borderline exception ends at 0.7 or NSFWJS agreement above 0.3', async () => {
  const borderline = sampler();
  await borderline.sample(scores(0.7, 0.3));
  assert.equal(borderline.track.verdict, 'clean');
  const stronger = sampler();
  await stronger.sample(scores(0.70001));
  assert.equal(stronger.track.verdict, 'blocked');
  const agreed = sampler();
  await agreed.sample(scores(0.6, 0.30001));
  assert.equal(agreed.track.verdict, 'blocked');
});

test('paused shown video also tolerates one safety-only spike', async () => {
  const s = sampler({ shown: true, paused: true });
  await s.sample(scores(0.95));
  assert.equal(s.track.verdict, 'clean');
  await s.sample(scores(0.99, 0.99));
  assert.equal(s.track.verdict, 'blocked');
});

test('no-safety fallback still confirms strong NSFWJS immediately', async () => {
  const s = sampler({ shown: true });
  await s.sample(scores(undefined, 0.99));
  assert.equal(s.track.verdict, 'blocked');
  assert.equal(s.video.paused, true);
});

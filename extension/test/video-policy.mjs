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
const startupEntry = join(temporary, 'startup.mjs');
await esbuild.build({
  entryPoints: [join(import.meta.dirname, '../src/content/video.ts')],
  outfile: startupEntry, bundle: true, format: 'esm', define: { __DEV__: 'true' }, logLevel: 'silent',
});
const { VideoWatcher: StartupVideoWatcher } = await import(pathToFileURL(startupEntry).href);
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
function sampler({ shown = false, paused = false, preset = 'balanced', experiment = false } = {}) {
  let result = scores(0.01);
  const stamps = [];
  const rows = [];
  const Watcher = experiment ? StartupVideoWatcher : VideoWatcher;
  const watcher = new Watcher({ classifyFrame: async () => result }, { set: (_, s) => stamps.push(s) }, { record: (...r) => rows.push(r) });
  watcher.settings = { enabled: true, preset };
  const video = { dataset: {}, paused, currentTime: 1, duration: 100, videoWidth: 448, videoHeight: 252, hasAttribute: () => false, pause() { this.paused = true; } };
  const track = { src: 'numeric-fixture', recent: [], cleanStreak: 0, every: 1000, generation: 0, failures: 0, ...(shown ? { verdict: 'clean' } : {}) };
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

test('shown borderline exception ends at 0.7 or NSFWJS agreement above 0.3', async () => {
  const borderline = sampler({ shown: true });
  await borderline.sample(scores(0.7, 0.3));
  assert.equal(borderline.track.verdict, 'clean');
  const stronger = sampler({ shown: true });
  await stronger.sample(scores(0.70001));
  assert.deepEqual(stronger.track.recent, ['flagged']);
  const agreed = sampler({ shown: true });
  await agreed.sample(scores(0.6, 0.30001));
  assert.deepEqual(agreed.track.recent, ['flagged']);
});

test('dev startup requires corroboration through 0.9, with strict threshold boundaries', async () => {
  for (const paused of [false, true]) {
    for (const safety of [0.5, 0.7, 0.8, 0.9]) {
      const quiet = sampler({ paused, experiment: true });
      await quiet.sample(scores(safety, 0.15));
      assert.equal(quiet.track.verdict, 'clean');
      assert.equal(quiet.track.revealed, true);
    }
    const supported = sampler({ paused, experiment: true });
    await supported.sample(scores(0.8, 0.15001));
    assert.equal(supported.track.verdict, 'blocked');
    const strong = sampler({ paused, experiment: true });
    await strong.sample(scores(0.90001));
    assert.equal(strong.track.verdict, 'blocked');
    const low = sampler({ paused, experiment: true });
    await low.sample(scores(0.5, 0.2));
    assert.equal(low.track.verdict, 'clean');
  }
});

test('startup never suppresses independent hentai or sexy flags in any preset', async () => {
  for (const preset of Object.keys(PRESETS)) {
    for (const result of [scores(0.01, 0, 0.99), scores(0.01, 0, 0, 0.99)]) {
      const sampled = sampler({ preset, experiment: true });
      await sampled.sample(result);
      assert.equal(sampled.track.verdict, 'blocked');
    }
  }
});

test('startup does not weaken a confirmed block after a video has been shown', async () => {
  const sampled = sampler({ experiment: true });
  sampled.video.pause = () => {};
  await sampled.sample(scores(0.01));
  await sampled.sample(scores(0.95));
  await sampled.sample(scores(0.95));
  assert.equal(sampled.track.verdict, 'blocked');
  await sampled.sample(scores(0.8));
  assert.equal(sampled.track.verdict, 'blocked');
  await sampled.sample(scores(0.01));
  await sampled.sample(scores(0.01));
  assert.equal(sampled.track.verdict, 'blocked');
  await sampled.sample(scores(0.01));
  assert.equal(sampled.track.verdict, 'clean');
});

test('new sources reset startup eligibility, restoring the same source preserves it', async () => {
  const sampled = sampler({ experiment: true });
  await sampled.sample(scores(0.01));
  const watcher = new VideoWatcher({ classifyFrame: async () => scores(0.01) }, { set() {} }, { record() {} });
  watcher.reset(sampled.track, true);
  assert.equal(sampled.track.revealed, true);
  watcher.reset(sampled.track);
  assert.equal(sampled.track.revealed, false);
  assert.equal(sampled.track.verdict, undefined);
});

test('production retains the original startup threshold until the experiment is justified', async () => {
  const sampled = sampler();
  await sampled.sample(scores(0.8));
  assert.equal(sampled.track.verdict, 'blocked');
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

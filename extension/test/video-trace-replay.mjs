// Replay identical recorded scores through the actual before/after watcher code,
// separating policy effects from differences in live playback/sampling positions.
// node test/video-trace-replay.mjs <trace.json> <baseline git commit>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const [input, baseline, outputFile] = process.argv.slice(2);
if (!input || !baseline) throw new Error('usage: video-trace-replay.mjs <trace.json> <baseline commit>');
const root = resolve(import.meta.dirname, '..');
const report = JSON.parse(readFileSync(input, 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'tz-video-replay-'));
if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('tz-video-replay-')) throw new Error('unexpected temporary path');
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'recorded-numeric-scores' }) };
globalThis.location = { hostname: 'www.youtube.com' }; // real trace: YouTube, plus a clean local flower clip
try {
  const result = {};
  for (const mode of ['before', 'after']) {
    const output = join(temporary, `${mode}.mjs`);
    await esbuild.build({
      entryPoints: [join(root, 'src/content/video.ts')], outfile: output, bundle: true, format: 'esm',
      define: { __DEV__: 'false' }, logLevel: 'silent',
      plugins: mode === 'before' ? [{ name: 'baseline-sources', setup(build) {
        build.onLoad({ filter: /[\\/]src[\\/](?:content[\\/]video|shared[\\/]policy)\.ts$/ }, ({ path }) => {
          const relative = path.endsWith(`${join('content', 'video.ts')}`) ? 'content/video.ts' : 'shared/policy.ts';
          const contents = execFileSync('git', ['show', `${baseline}:extension/src/${relative}`], { cwd: root, encoding: 'utf8' });
          return { contents, loader: 'ts', resolveDir: dirname(path) };
        });
      } }] : [],
    });
    const { VideoWatcher } = await import(pathToFileURL(output).href);
    const videos = [];
    for (const row of report.videos) {
      let current;
      const transitions = [];
      const watcher = new VideoWatcher({ classifyFrame: async () => current }, { set() {} }, { record: (...r) => transitions.push({ decision: r[1], frame: r[4], why: r[5] }) });
      watcher.settings = { enabled: true, preset: 'balanced' };
      const video = { paused: false, currentTime: 0, duration: 1000, videoWidth: 448, videoHeight: 252, hasAttribute: () => false, pause() { throw new Error('YouTube should not pause'); } };
      watcher.tracks.set(video, { recent: [], cleanStreak: 0, every: 1000, generation: 0, failures: 0 });
      for (const frame of row.samples) {
        const { porn, hentai, sexy, neutral, safety } = frame;
        current = { safety, whole: { porn, hentai, sexy, neutral, drawing: 1 - porn - hentai - sexy - neutral }, width: 448, height: 252 };
        video.currentTime = frame.at;
        await watcher.sample(video);
      }
      let shown = false;
      let midWatchTransitions = 0;
      for (const t of transitions) {
        if (t.decision === 'clean') shown = true;
        else if (shown) midWatchTransitions++;
      }
      videos.push({ url: row.url, blocked: transitions.some((t) => t.decision === 'blocked'), midWatchTransitions, transitions });
    }
    result[mode] = { videos, summary: {
      routes: videos.length, blocked: videos.filter((v) => v.blocked).length,
      midWatchTransitions: videos.reduce((n, v) => n + v.midWatchTransitions, 0),
      obvious: videos.flatMap((v) => v.transitions).filter((t) => t.decision === 'blocked' && t.frame?.obvious).length,
    } };
  }
  if (outputFile) writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(outputFile ? { before: result.before.summary, after: result.after.summary } : result, null, 2));
} finally { rmSync(temporary, { recursive: true, force: true }); }

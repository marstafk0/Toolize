import { NSFWJS_MODELS, NsfwjsClassifier, type NsfwjsModel } from '../offscreen/nsfwjs-classifier';
import { ClassifyPipeline } from '../offscreen/pipeline';
import { SafetyClassifier } from '../offscreen/safety-classifier';
import { hashString } from '../shared/hash';
import { decide, PRESETS, type ClassifyResult, type Preset } from '../shared/policy';

/**
 * Dev-only regression page: chrome-extension://<id>/corpus/corpus.html?server=http://localhost:8787
 *
 * Runs the exact production pipeline over your labelled corpus (test/corpus/{safe,flag}/<category>/...)
 * and reports false-positive / false-negative rates per preset, per category. Every
 * image gets its whole + tile scores once; each preset then replays the runtime
 * decision (tiles only count when the whole-image score was borderline).
 * Run it on every model/threshold change. Results are POSTed back to the test server
 * and saved under test/corpus/results/.
 */

interface Entry {
  url: string;
  label: 'safe' | 'flag';
  category: string;
}
interface Scored extends Entry {
  result?: ClassifyResult;
  error?: string;
}

const params = new URLSearchParams(location.search);
const server = params.get('server') ?? 'http://localhost:8787';
/** ?model=mobilenet_v2_mid|inception_v3 compares another NSFWJS model (dev builds carry all three). */
const variant = (params.get('model') ?? 'mobilenet_v2') as NsfwjsModel;
const $ = (id: string) => document.getElementById(id)!;

/** Every corpus result carries tiles, so decide() never returns 'refine' here. */
function runtimeDecision(r: ClassifyResult, preset: Preset): boolean {
  return decide(r, PRESETS[preset]) === 'blocked';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : '–';
}

async function main(): Promise<void> {
  const entries: Entry[] = await (await fetch(`${server}/corpus/index.json`)).json();
  if (!entries.length) {
    $('status').textContent = 'Corpus is empty. Put images in test/corpus/safe/<category>/ and test/corpus/flag/<category>/.';
    (window as any).__corpusDone = { empty: true };
    return;
  }

  if (!(variant in NSFWJS_MODELS)) throw new Error(`unknown model ${variant}`);
  const classifier = new NsfwjsClassifier(
    chrome.runtime.getURL(`models/${variant}/model.json`),
    chrome.runtime.getURL('wasm/'),
    variant,
  );
  await classifier.load();
  const pipeline = new ClassifyPipeline(classifier);
  // Same as the offscreen document: the safety model decides when WebGPU can run it.
  // ?safety=0 measures NSFWJS alone.
  const safety = new SafetyClassifier(chrome.runtime.getURL('models/safety/safety.onnx'), chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.wasm'));
  if (params.get('safety') !== '0') {
    await safety.load();
    if (safety.ready) pipeline.useSafety(safety);
  }
  const engine = `${classifier.modelName}${safety.ready ? ' + safety' : ` (safety off: ${safety.error ?? 'disabled'})`}`;

  const scored: Scored[] = [];
  let done = 0;
  const t0 = performance.now();
  await Promise.all(
    entries.map(async (e) => {
      const url = server + e.url;
      try {
        // refine=true: always compute tiles so every preset can be replayed offline.
        scored.push({ ...e, result: await pipeline.classify({ key: hashString(url), source: { url }, refine: true }) });
      } catch (err) {
        scored.push({ ...e, error: String((err as Error)?.message ?? err) });
      }
      $('status').textContent = `Classified ${++done}/${entries.length} (${classifier.backend})…`;
    }),
  );
  const secs = (performance.now() - t0) / 1000;

  const presets = Object.keys(PRESETS) as Preset[];
  const categories = [...new Set(scored.map((s) => `${s.label}/${s.category}`))].sort();
  const ok = scored.filter((s) => s.result);
  type Row = { name: string; n: number; wrong: Record<Preset, number>; kind: 'FP' | 'FN' };
  const rows: Row[] = [];
  const addRow = (name: string, items: Scored[], kind: 'FP' | 'FN') => {
    const wrong = {} as Record<Preset, number>;
    for (const p of presets) {
      wrong[p] = items.filter((s) => runtimeDecision(s.result!, p) === (kind === 'FP')).length;
    }
    rows.push({ name, n: items.length, wrong, kind });
  };
  addRow('ALL safe (false positives)', ok.filter((s) => s.label === 'safe'), 'FP');
  addRow('ALL flag (false negatives)', ok.filter((s) => s.label === 'flag'), 'FN');
  for (const c of categories) {
    const [label, category] = c.split('/');
    addRow(c, ok.filter((s) => s.label === label && s.category === category), label === 'safe' ? 'FP' : 'FN');
  }

  $('status').textContent =
    `${entries.length} images · ${scored.length - ok.length} failed to load · ${secs.toFixed(1)}s ` +
    `(${classifier.backend}, ${engine})`;
  $('summary').innerHTML = `<table><thead><tr><th>Set</th><th>n</th><th>Metric</th>${presets
    .map((p) => `<th>${p}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${r.n}</td><td>${r.kind}</td>${presets
          .map((p) => `<td class="${r.wrong[p] ? 'bad' : ''}">${r.wrong[p]} (${pct(r.wrong[p], r.n)})</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;

  const misses = ok.filter((s) => runtimeDecision(s.result!, 'balanced') !== (s.label === 'flag'));
  $('misses').innerHTML = `<h2>Misclassified at <em>balanced</em> (${misses.length}) — hover to unblur</h2><div class="grid">${misses
    .map((s) => {
      const w = s.result!.whole;
      const t = s.result!.tiles;
      return `<div class="miss"><img src="${esc(server + s.url)}"><div><b>${s.label === 'safe' ? 'FP' : 'FN'}</b> ${esc(s.category)}</div>
        <div>whole p${w.porn.toFixed(2)} h${w.hentai.toFixed(2)} s${w.sexy.toFixed(2)}</div>
        ${t ? `<div>tiles p${t.porn.toFixed(2)} h${t.hentai.toFixed(2)} s${t.sexy.toFixed(2)}</div>` : ''}
        <div class="muted">${esc(decodeURIComponent(s.url.split('/').pop()!))}</div></div>`;
    })
    .join('')}</div>`;

  const report = {
    at: new Date().toISOString(),
    model: engine,
    backend: classifier.backend,
    presets: PRESETS,
    seconds: secs,
    rows,
    images: scored.map((s) => ({ url: s.url, label: s.label, category: s.category, error: s.error, ...s.result })),
  };
  await fetch(`${server}/corpus/results`, { method: 'POST', body: JSON.stringify(report, null, 1) }).catch(() => {});
  (window as any).__corpusDone = { rows, total: entries.length, failed: scored.length - ok.length, seconds: secs, backend: classifier.backend, engine };
}

main().catch((e) => {
  $('status').textContent = `Failed: ${e?.message ?? e}`;
  (window as any).__corpusDone = { error: String(e?.message ?? e) };
});

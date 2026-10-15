import type { ClassifyResponse, EngineInfo, Message } from '../shared/messages';
import { FetchError } from './image-loader';
import { NsfwjsClassifier } from './nsfwjs-classifier';
import { ClassifyPipeline } from './pipeline';
import { SafetyClassifier } from './safety-classifier';

/**
 * Offscreen document: owns the model. MV3 service workers can't do canvas/WebGL
 * reliably, so all decoding + inference lives here, in the extension's own origin —
 * never injected into pages, never sends pixels anywhere.
 */

const classifier = new NsfwjsClassifier(
  chrome.runtime.getURL('models/mobilenet_v2/model.json'),
  chrome.runtime.getURL('wasm/'),
);
const pipeline = new ClassifyPipeline(classifier);
const SAFETY_LOAD_TIMEOUT_MS = 20_000;
const safety = new SafetyClassifier(
  chrome.runtime.getURL('models/safety/safety.onnx'),
  chrome.runtime.getURL('ort/ort-wasm-simd-threaded.jsep.wasm'),
);
let loadError: string | undefined;
let loadMs = -1;
const t0 = performance.now();
// Both models load at once. Classification waits for the safety model too (images stay
// blurred meanwhile): verdicts are cached, and ones made without it would stick. If it
// can't run (no WebGPU), NSFWJS decides alone. The wait is bounded — a GPU process that
// never answers would otherwise hold every image back — and a late load still switches
// it on for later images.
const safetyLoaded = safety.load().then(() => {
  if (safety.ready) pipeline.useSafety(safety);
  else console.warn('[toolize] safety model off:', safety.error);
});
const ready = classifier.load().then(async () => {
  pipeline.useGpu(classifier.backend === 'webgl');
  await Promise.race([safetyLoaded, new Promise((r) => setTimeout(r, SAFETY_LOAD_TIMEOUT_MS))]);
  if (!safety.ready && !safety.error) safety.error = `still loading after ${SAFETY_LOAD_TIMEOUT_MS / 1000} s`;
  loadMs = Math.round(performance.now() - t0);
}).catch((e) => {
  loadError = String(e?.message ?? e);
  console.error('[toolize] model load failed', e);
  throw e;
});

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.kind === 'classify') {
    ready
      .then(() => pipeline.classify(msg))
      .then(
        (result): ClassifyResponse => ({ ok: true, result }),
        (e): ClassifyResponse => ({
          ok: false,
          error: String(e?.message ?? e),
          fetchFailed: e instanceof FetchError,
        }),
      )
      .then(sendResponse);
    return true;
  }

  if (msg.kind === 'engineInfo') {
    const info: EngineInfo = {
      ready: classifier.backend !== 'none' && !loadError,
      backend: classifier.backend,
      model: safety.ready ? `${classifier.modelName} + safety (webgpu)` : classifier.modelName,
      safety: safety.ready ? 'webgpu' : safety.error ?? 'loading',
      loadMs,
      classified: pipeline.classified,
      avgInferMs: Math.round(pipeline.avgMs),
      cacheSize: pipeline.cacheSize,
      warnings: classifier.warnings,
      warming: classifier.warming,
      perf: pipeline.perf,
      error: loadError,
    };
    sendResponse(info);
    return false;
  }
  return false;
});

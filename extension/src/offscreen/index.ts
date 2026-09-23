import type { ClassifyResponse, EngineInfo, Message } from '../shared/messages';
import { FetchError } from './image-loader';
import { NsfwjsClassifier } from './nsfwjs-classifier';
import { ClassifyPipeline } from './pipeline';

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
let loadError: string | undefined;
let loadMs = -1;
const t0 = performance.now();
const ready = classifier.load().then(() => void (loadMs = Math.round(performance.now() - t0))).catch((e) => {
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
      model: classifier.modelName,
      loadMs,
      classified: pipeline.classified,
      avgInferMs: Math.round(pipeline.avgMs),
      cacheSize: pipeline.cacheSize,
      warnings: classifier.warnings,
      warming: classifier.warming,
      error: loadError,
    };
    sendResponse(info);
    return false;
  }
  return false;
});

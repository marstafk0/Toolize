import * as tf from '@tensorflow/tfjs-core';
import { loadLayersModel, type LayersModel } from '@tensorflow/tfjs-layers';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import type { Scores } from '../shared/policy';
import type { ImageClassifier } from './classifier';

// NSFWJS output order (see nsfwjs/dist/esm/nsfw_classes.js).
const OUTPUT_ORDER = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'] as const;

/**
 * NSFWJS MobileNetV2 (224px, softmax over 5 classes). The model is shipped inside the
 * extension (extracted from the nsfwjs package at build time) — no network, ever.
 * Preprocessing mirrors NSFWJS.infer: RGB / 255, no mean subtraction.
 */
export class NsfwjsClassifier implements ImageClassifier {
  readonly modelName = 'nsfwjs-mobilenet_v2';
  readonly inputSize = 224;
  backend = 'none';
  /** Why preferred backends were skipped (shown in the popup when degraded). */
  readonly warnings: string[] = [];
  private model: LayersModel | null = null;

  /** @param wasmDir extension URL of the directory holding the tfjs-backend-wasm binaries */
  constructor(
    private readonly modelUrl: string,
    wasmDir: string,
  ) {
    setWasmPaths(wasmDir);
  }

  async load(): Promise<void> {
    // Shape-agnostic WebGL shaders: fewer recompiles when input shapes vary.
    tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true);
    // Threaded WASM needs a cross-origin-isolated document (not ours); the feature probe
    // can still pass, which would fetch a binary we don't ship. Use single-thread SIMD.
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
    // GPU WebGL is fastest. But a software GL (SwiftShader/llvmpipe on GPU-less or
    // blocklisted machines) is several times slower than SIMD WASM — prefer WASM there.
    const softwareGL = isSoftwareGL();
    if (softwareGL) this.warnings.push('no hardware WebGL');
    const order = softwareGL ? ['wasm', 'webgl', 'cpu'] : ['webgl', 'wasm', 'cpu'];
    for (const b of order) {
      // TF.js swallows backend init errors into console.warn; capture the reason.
      const warn = console.warn;
      const logged: string[] = [];
      console.warn = (...args: unknown[]) => {
        logged.push(args.map(String).join(' ').split('\n')[0]);
        warn(...args);
      };
      const reason = () => logged.join(' — ').slice(0, 300);
      try {
        if (await tf.setBackend(b)) {
          await tf.ready();
          this.backend = b;
          break;
        }
        this.warnings.push(`${b}: ${reason() || 'unavailable'}`);
      } catch (e) {
        this.warnings.push(`${b}: ${(e as Error)?.message ?? e}`);
      } finally {
        console.warn = warn;
      }
    }
    if (this.backend === 'none') throw new Error('no TF.js backend available');
    tf.enableProdMode(); // after backend init: prod mode also silences init-failure warnings

    this.model = await loadLayersModel(this.modelUrl);
    // Warm the full preprocessing + inference path. Batch size 1 now (→ ready fast); the
    // other buckets in the background, between requests. Until a bucket is warm, batches
    // are split into warm sizes, so no real request pays shader compilation.
    this.warm(1);
    void this.warmRest();
  }

  private warmed = new Set<number>();

  /** True while some batch buckets still need their one-time shader compile. */
  get warming(): boolean {
    return this.warmed.size < BATCH_BUCKETS.length;
  }

  private warm(size: number): void {
    const blank = new ImageData(this.inputSize, this.inputSize);
    this.runBucket(Array(size).fill(blank), size);
    if (size > 1) this.runBucket(Array(size - 1).fill(blank), size); // padded variant
    this.warmed.add(size);
  }

  private lastUse = 0;

  /** Each warm step blocks ~1s+ of GPU compile — only do it while nobody's waiting. */
  private async warmRest(): Promise<void> {
    for (const size of BATCH_BUCKETS) {
      if (this.warmed.has(size)) continue;
      do await new Promise((r) => setTimeout(r, 500));
      while (performance.now() - this.lastUse < 1500);
      this.warm(size);
    }
  }

  async classifyBatch(inputs: ImageData[]): Promise<Scores[]> {
    this.lastUse = performance.now();
    const warm = BATCH_BUCKETS.filter((b) => this.warmed.has(b));
    const out: Scores[] = [];
    for (let i = 0; i < inputs.length; ) {
      const left = inputs.length - i;
      // Smallest warm bucket that fits the rest, else the largest warm one (and loop).
      const size = warm.find((b) => b >= left) ?? warm[warm.length - 1];
      const n = Math.min(size, left);
      out.push(...this.runBucket(inputs.slice(i, i + n), size));
      i += n;
    }
    return out;
  }

  /**
   * Pads to a fixed bucket size: WebGL programs are compiled per input shape, and an
   * uncached shape costs seconds. Padding rows are cheap by comparison.
   */
  private runBucket(inputs: ImageData[], size: number): Scores[] {
    const model = this.model;
    if (!model) throw new Error('classifier not loaded');
    if (inputs.length === 0) return [];

    const out = tf.tidy(() => {
      // Functional ops: bare tfjs-core doesn't register chained ops (.toFloat() etc).
      const pixels = tf.stack(inputs.map((d) => tf.browser.fromPixels(d, 3)));
      const padded = size > inputs.length ? tf.pad(pixels, [[0, size - inputs.length], [0, 0], [0, 0], [0, 0]]) : pixels;
      const batch = tf.div(tf.cast(padded, 'float32'), 255);
      return model.predict(batch) as tf.Tensor;
    });
    // dataSync, not data(): the async WebGL readback polls a GPU fence with setTimeout,
    // and the offscreen doc is a hidden page where Chrome throttles timers to ~1s.
    // Blocking here is harmless — this thread belongs to the extension, not the page.
    const data = out.dataSync();
    out.dispose();

    const n = OUTPUT_ORDER.length;
    return inputs.map((_, i) => {
      const s = {} as Scores;
      OUTPUT_ORDER.forEach((name, j) => (s[name] = data[i * n + j]));
      return s;
    });
  }
}

/** Fixed batch shapes (see runBucket). Largest = max batch per inference call. */
const BATCH_BUCKETS = [1, 2, 4, 8]; // keep the largest in step with MAX_BATCH (pipeline.ts)

function isSoftwareGL(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  } catch {
    return true;
  }
}

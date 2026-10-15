import * as ort from 'onnxruntime-web/webgpu';

/**
 * The safety model: OpenAI CLIP RN50's image tower (MIT) plus a small head trained to
 * answer one question, "should this be hidden?", on 48K labelled NSFW/SFW images and ~2K
 * hard negatives (skin close-ups, rashes, raw meat, gym, faces) — the pictures NSFWJS
 * gets wrong. One ONNX file: RGB 0..1 at 224x224 (whole image squashed) in, P(block)
 * out; CLIP's normalisation is inside. Training and export: tools/safety-model/.
 *
 * WebGPU only. On a GPU a batch of 8 takes ~20 ms; on WASM a single image takes ~470 ms,
 * too slow to run on every picture, so without WebGPU this stays off and NSFWJS decides
 * alone, as before.
 */
export class SafetyClassifier {
  readonly inputSize = 224;
  ready = false;
  /** Why it isn't running (shown in the popup's engine info). */
  error: string | null = null;
  private session: ort.InferenceSession | null = null;
  private warmed = new Set<number>();
  private lastUse = 0;

  constructor(
    private readonly modelUrl: string,
    private readonly wasmUrl: string,
  ) {}

  async load(): Promise<void> {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter');
      const info = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string } }).info;
      if (info && /swiftshader|software|basic render/i.test(`${info.vendor} ${info.architecture} ${info.description}`)) {
        throw new Error('WebGPU is software-rendered');
      }
      // Single-threaded: threads need a cross-origin-isolated page, which this isn't.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { wasm: this.wasmUrl };
      ort.env.logLevel = 'error';
      this.session = await ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      await this.warm(1);
      this.ready = true;
      void this.warmRest();
    } catch (e) {
      this.error = String((e as Error)?.message ?? e).slice(0, 200);
      this.session = null;
    }
  }

  /** Each bucket compiles its shaders on first use; do that before real requests need it. */
  private async warm(size: number): Promise<void> {
    await this.runBucket(Array(size).fill(new ImageData(this.inputSize, this.inputSize)), size);
    this.warmed.add(size);
  }

  private async warmRest(): Promise<void> {
    for (const size of BUCKETS) {
      if (this.warmed.has(size)) continue;
      do await new Promise((r) => setTimeout(r, 500));
      while (performance.now() - this.lastUse < 1500);
      await this.warm(size).catch(() => {});
    }
  }

  /** P(block) per input, same order. Inputs are inputSize x inputSize. */
  async classifyBatch(inputs: ImageData[]): Promise<number[]> {
    this.lastUse = performance.now();
    const warm = BUCKETS.filter((b) => this.warmed.has(b));
    const out: number[] = [];
    for (let i = 0; i < inputs.length; ) {
      const left = inputs.length - i;
      const size = warm.find((b) => b >= left) ?? warm[warm.length - 1];
      const n = Math.min(size, left);
      out.push(...(await this.runBucket(inputs.slice(i, i + n), size)));
      i += n;
    }
    return out;
  }

  private async runBucket(inputs: ImageData[], size: number): Promise<number[]> {
    const session = this.session;
    if (!session) throw new Error('safety model not loaded');
    const s = this.inputSize;
    const plane = s * s;
    const data = new Float32Array(size * 3 * plane); // padding rows stay zero
    inputs.forEach((img, b) => {
      const px = img.data;
      const base = b * 3 * plane;
      for (let i = 0; i < plane; i++) {
        data[base + i] = px[i * 4] / 255;
        data[base + plane + i] = px[i * 4 + 1] / 255;
        data[base + 2 * plane + i] = px[i * 4 + 2] / 255;
      }
    });
    const feeds = { pixels: new ort.Tensor('float32', data, [size, 3, s, s]) };
    const result = await session.run(feeds);
    const probs = result.probs.data as Float32Array;
    result.probs.dispose();
    return Array.from(probs.slice(0, inputs.length));
  }
}

/** Fixed batch shapes, as for NSFWJS: WebGPU compiles per input shape. */
const BUCKETS = [1, 2, 4, 8];

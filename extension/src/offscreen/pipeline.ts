import { maxScores, type ClassifyResult, type Scores } from '../shared/policy';
import type { ImageSource, PipelinePerf } from '../shared/messages';
import type { ImageClassifier } from './classifier';
import { cropToImageData, decodeBlob, fetchImageBlob, tileRects } from './image-loader';
import { loadVideoFrames } from './video-loader';

/** A classification request as the pipeline sees it (the wire message minus routing). */
export interface ClassifyJob {
  key: string;
  source: ImageSource;
  refine: boolean;
  cache?: boolean;
  testTag?: string;
}

const CACHE_MAX = 5000;
/**
 * The GPU is shared with the whole browser: one long inference call stalls drawing in
 * every window (users saw Brave and Edge freeze on image-heavy sites). Batches stay
 * small enough that each call is short.
 */
const MAX_BATCH = 8;
/**
 * Jobs in flight. On a GPU they mostly wait on the network (the refetch is the slowest
 * step on real sites), so this is generous. Without one, inference shares the thread
 * with cropping and extra jobs only compete with it, so it stays low.
 */
const MAX_CONCURRENT_JOBS = { gpu: 8, cpu: 6 };
/** Decodes + crops at once. More than this and they slow each other down. */
const MAX_CONCURRENT_DECODES = 4;

/**
 * fetch/decode -> crop -> batched inference, with an LRU result cache keyed by URL hash
 * and in-flight de-duplication (the same avatar 40x on a page = one inference).
 */
export class ClassifyPipeline {
  private cache = new Map<string, ClassifyResult>();
  private inflight = new Map<string, Promise<ClassifyResult>>();
  private batcher: Batcher;
  private jobSlots = new Semaphore(MAX_CONCURRENT_JOBS.cpu);
  private decodeSlots = new Semaphore(MAX_CONCURRENT_DECODES);
  classified = 0;
  private totalMs = 0;
  private stage = { jobs: 0, fetch: 0, decode: 0, crop: 0, infer: 0 };

  get perf(): PipelinePerf {
    const n = this.stage.jobs || 1;
    const b = this.batcher.stats;
    return {
      jobs: this.stage.jobs,
      fetchMs: Math.round(this.stage.fetch / n),
      decodeMs: Math.round(this.stage.decode / n),
      cropMs: Math.round(this.stage.crop / n),
      inferWaitMs: Math.round(this.stage.infer / n),
      batches: b.batches,
      avgBatch: b.batches ? +(b.items / b.batches).toFixed(1) : 0,
      batchMs: b.batches ? Math.round(b.ms / b.batches) : 0,
    };
  }

  constructor(private readonly classifier: ImageClassifier) {
    this.batcher = new Batcher(classifier);
  }

  /** Called once the backend is known. */
  useGpu(gpu: boolean): void {
    this.jobSlots.resize(gpu ? MAX_CONCURRENT_JOBS.gpu : MAX_CONCURRENT_JOBS.cpu);
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get avgMs(): number {
    return this.classified ? this.totalMs / this.classified : 0;
  }

  classify(req: ClassifyJob): Promise<ClassifyResult> {
    const { key, refine, cache = true } = req;
    const cached = cache ? this.cache.get(key) : undefined;
    if (cached && (cached.tiles || !refine)) {
      this.touch(key, cached);
      return Promise.resolve(cached);
    }
    // Uncached (one-shot) jobs are never the "same request" as anything else, even if
    // a caller reuses a key — sharing a result between two videos would be wrong.
    if (!cache) return this.jobSlots.run(() => this.run(req));
    const flightKey = `${key}|${refine ? 1 : 0}`;
    let p = this.inflight.get(flightKey);
    if (!p) {
      p = this.jobSlots
        .run(() => this.run(req, cached))
        .then((r) => {
          if (cache) this.touch(key, r);
          return r;
        })
        .finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, p);
    }
    return p;
  }

  private async run(req: ClassifyJob, prior?: ClassifyResult): Promise<ClassifyResult> {
    if (__DEV__ && devFailOnce(req)) throw new Error('test: transient failure');
    const t0 = performance.now();
    const { source, refine } = req;
    let t = performance.now();
    const lap = () => {
      const now = performance.now();
      const ms = now - t;
      t = now;
      return ms;
    };
    let frames;
    let fetchMs = 0;
    let decodeMs = 0;
    if ('videoUrl' in source) {
      frames = await loadVideoFrames(source.videoUrl);
      fetchMs = lap();
    } else {
      const blob = 'url' in source ? await fetchImageBlob(source.url) : await (await fetch(source.dataUrl)).blob();
      fetchMs = lap();
      frames = [await this.decodeSlots.run(() => decodeBlob(blob))];
      decodeMs = lap();
    }
    try {
      const size = this.classifier.inputSize;
      // One "whole" input per frame (a single image is just a one-frame video), plus
      // full-resolution tiles when refining. Per class, the worst frame decides.
      const inputs: ImageData[] = [];
      let tileCount = 0;
      for (const f of frames) {
        if (!prior) inputs.push(cropToImageData(f, { x: 0, y: 0, w: f.width, h: f.height }, size));
        if (!refine) continue;
        const rects = tileRects(f.width, f.height).slice(0, frames.length > 1 ? 4 : undefined);
        for (const r of rects) inputs.push(cropToImageData(f, r, size));
        tileCount += rects.length;
      }

      const cropMs = lap();
      const scores = await this.batcher.submit(inputs);
      const s = this.stage;
      s.jobs++;
      s.fetch += fetchMs;
      s.decode += decodeMs;
      s.crop += cropMs;
      s.infer += lap();
      const wholeCount = prior ? 0 : frames.length;
      let whole = prior ? prior.whole : maxScores(scores.slice(0, wholeCount));
      let tileMax = tileCount ? maxScores(scores.slice(wholeCount)) : undefined;
      if (__DEV__) [whole, tileMax] = devOverride(req, whole, tileMax);

      this.classified++;
      this.totalMs += performance.now() - t0;
      return { whole, tiles: tileMax, width: frames[0].width, height: frames[0].height };
    } finally {
      for (const f of frames) f.close();
    }
  }

  private touch(key: string, r: ClassifyResult): void {
    this.cache.delete(key);
    this.cache.set(key, r);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }
}

/**
 * Collects crops from concurrent jobs into tensor batches. One drain loop runs
 * inference; whatever arrived while a batch was on the GPU forms the next batch, so a
 * burst (page load, fast scroll) naturally shares round-trips with no fixed delay.
 */
class Batcher {
  private queue: { input: ImageData; resolve: (s: Scores) => void; reject: (e: unknown) => void }[] = [];
  private draining = false;
  readonly stats = { batches: 0, items: 0, ms: 0 };

  constructor(private readonly classifier: ImageClassifier) {}

  submit(inputs: ImageData[]): Promise<Scores[]> {
    const p = Promise.all(
      inputs.map((input) => new Promise<Scores>((resolve, reject) => this.queue.push({ input, resolve, reject }))),
    );
    if (!this.draining) {
      this.draining = true;
      postTask(() => void this.drain()); // one task of slack lets same-tick submissions join
    }
    return p;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const items = this.queue.splice(0, MAX_BATCH);
      try {
        const t0 = performance.now();
        const scores = await this.classifier.classifyBatch(items.map((i) => i.input));
        this.stats.batches++;
        this.stats.items += items.length;
        this.stats.ms += performance.now() - t0;
        items.forEach((it, i) => it.resolve(scores[i]));
      } catch (e) {
        items.forEach((it) => it.reject(e));
      }
      await new Promise<void>(postTask); // let finished decodes enqueue before the next batch
    }
    this.draining = false;
  }
}

/**
 * Macrotask scheduling that isn't throttled. The offscreen document is a hidden page,
 * where Chrome clamps setTimeout to ~1s — posted messages are exempt.
 */
const taskChannel = new MessageChannel();
const tasks: (() => void)[] = [];
taskChannel.port1.onmessage = () => tasks.shift()?.();
function postTask(fn: () => void): void {
  tasks.push(fn);
  taskChannel.port2.postMessage(null);
}

class Semaphore {
  private waiters: (() => void)[] = [];
  private limit: number;
  constructor(private free: number) {
    this.limit = free;
  }

  resize(limit: number): void {
    this.free += limit - this.limit;
    this.limit = limit;
    while (this.free > 0 && this.waiters.length) {
      this.free--;
      this.waiters.shift()!();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const devFailed = new Set<string>();
const devMild = new Set<string>();

/** Dev-build-only: the first request for a `__tz_test_fail_once` tag fails, as if transiently. */
function devFailOnce(req: ClassifyJob): boolean {
  const { source } = req;
  const tag = req.testTag ?? ('url' in source ? source.url : 'videoUrl' in source ? source.videoUrl : '');
  if (!tag.includes('__tz_test_fail_once') || devFailed.has(tag)) return false;
  devFailed.add(tag);
  return true;
}

/**
 * Dev-build-only test hooks so the e2e suite can exercise the blocked / refine paths
 * with synthetic images. Compiled out of production builds (__DEV__ = false).
 */
function devOverride(req: ClassifyJob, whole: Scores, tiles?: Scores): [Scores, Scores | undefined] {
  const { source } = req;
  // Video frames arrive as data URLs, so elements carry the tag as an attribute instead.
  const tag = req.testTag ?? ('url' in source ? source.url : 'videoUrl' in source ? source.videoUrl : '');
  const neutral: Scores = { drawing: 0, hentai: 0, neutral: 1, porn: 0, sexy: 0 };
  // Over the balanced threshold but not obviously explicit, for the first request only.
  if (tag.includes('__tz_test_mild_once') && !devMild.has(tag)) {
    devMild.add(tag);
    return [{ ...neutral, neutral: 0.4, porn: 0.6 }, tiles && { ...neutral, neutral: 0.4, porn: 0.6 }];
  }
  if (tag.includes('__tz_test_flag')) return [{ ...neutral, neutral: 0.01, porn: 0.99 }, tiles && { ...neutral, porn: 0.99 }];
  if (tag.includes('__tz_test_borderline'))
    return [{ ...neutral, neutral: 0.55, porn: 0.45 }, tiles && { ...neutral, neutral: 0.1, porn: 0.9 }];
  if (tag.includes('__tz_test_clean')) return [neutral, tiles && neutral];
  return [whole, tiles];
}

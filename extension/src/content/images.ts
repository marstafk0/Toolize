import type { ImageSource } from '../shared/messages';
import { decide, PRESETS, type ClassifyResult } from '../shared/policy';
import type { Settings } from '../shared/settings';
import { ClassifyClient, isFetchFailure } from './client';
import { extractPixels } from './extract';
import { NearViewportQueue } from './scheduler';
import type { Stamper, State } from './state';

/** Images under this size (px) are icons/emoji: not worth classifying. */
const MIN_SIDE = 48;
/** Classification attempts per image before it is left blurred for good. */
const MAX_ATTEMPTS = 3;
/** First retry delay; doubles each time. */
const RETRY_MS = 1500;

interface Track {
  src: string;
  key: string;
  refining?: boolean;
  attempts?: number;
}

/**
 * Per-element image classification. Nothing is revealed until it scores clean, so
 * explicit content never flashes; anything that fails stays blurred.
 */
export class ImageWatcher {
  private tracks = new WeakMap<HTMLImageElement, Track>();
  /** src changed but the new image hasn't loaded yet — decisions would be stale. */
  private stale = new WeakSet<HTMLImageElement>();
  private settings: Settings | null = null;

  private readonly queue = new NearViewportQueue(
    (el) => this.dispatch(el as HTMLImageElement),
    (el, rect) => {
      // Rendered smaller than an icon? Not worth a classification.
      if (rect.width > 0 && rect.width < MIN_SIDE && rect.height < MIN_SIDE) {
        this.stamper.set(el, 'skip');
        return false;
      }
      return true;
    },
  );

  constructor(
    private readonly client: ClassifyClient,
    private readonly stamper: Stamper,
  ) {}

  setSettings(s: Settings): void {
    this.settings = s;
  }

  stop(): void {
    this.queue.disconnect();
  }

  /**
   * src/srcset changed (virtualized lists recycle <img> nodes). `currentSrc` keeps
   * reporting the OLD url until the new image loads, so any decision now would be for
   * the wrong image. Hide it and wait for the load/error event.
   */
  markStale(img: HTMLImageElement): void {
    if (!this.settings?.enabled) return this.consider(img);
    this.stale.add(img);
    this.tracks.delete(img);
    this.queue.drop(img);
    this.stamper.set(img, this.pendingState());
  }

  onLoad(img: HTMLImageElement): void {
    this.stale.delete(img);
    this.consider(img);
  }

  /** Idempotent: (re)decides an image's state from its current src. */
  consider(img: HTMLImageElement): void {
    const s = this.settings;
    if (!s) return; // attribute absent = blurred by CSS
    if (!s.enabled) {
      this.queue.drop(img);
      return this.stamper.set(img, 'off');
    }

    const src = img.currentSrc || img.src;
    if (!src || this.stale.has(img)) return this.stamper.set(img, this.pendingState());

    let t = this.tracks.get(img);
    if (!t || t.src !== src) {
      t = { src, key: this.client.key(src) };
      this.tracks.set(img, t);
      this.queue.drop(img);
    }

    const known = this.client.cached(t.key);
    if (known) return this.apply(img, t, known);

    this.stamper.set(img, this.pendingState());
    if (!img.complete) return; // the load/error event brings us back
    if (img.naturalWidth === 0) return this.stamper.set(img, 'skip'); // broken: nothing to show
    if (isTiny(img)) return this.stamper.set(img, 'skip');
    this.queue.observe(img);
  }

  private async dispatch(img: HTMLImageElement): Promise<void> {
    const t = this.tracks.get(img);
    if (!t) return;
    try {
      const r = await this.request(img, t, false);
      if (this.current(img, t)) this.apply(img, t, r);
    } catch (e) {
      // A request that fails after protection was switched off must not re-stamp it.
      if (!this.current(img, t)) return;
      this.stamper.set(img, 'error');
      if (__DEV__) console.warn('[toolize] image classify failed', t.src.slice(0, 120), e);
      // Most failures are transient: the service worker or classifier restarting, a
      // dropped message, a CDN hiccup. Without a retry a perfectly fine thumbnail stays
      // blurred until the page is reloaded. It stays blurred while it waits.
      t.attempts = (t.attempts ?? 1) + 1;
      if (t.attempts <= MAX_ATTEMPTS) {
        setTimeout(() => {
          if (this.current(img, t) && img.isConnected) this.queue.observe(img);
        }, RETRY_MS * 2 ** (t.attempts - 2));
      }
    }
  }

  private apply(img: HTMLImageElement, t: Track, r: ClassifyResult): void {
    const d = decide(r, PRESETS[this.settings!.preset]);
    if (d !== 'refine') return this.stamper.set(img, d);

    // Borderline: stay hidden and re-score on full-resolution tiles.
    this.stamper.set(img, this.pendingState());
    if (t.refining) return;
    t.refining = true;
    this.request(img, t, true).then(
      (r2) => this.current(img, t) && this.apply(img, t, r2),
      () => this.current(img, t) && this.stamper.set(img, 'error'),
    );
  }

  /** Still the same image, and protection still on? */
  private current(img: HTMLImageElement, t: Track): boolean {
    return this.tracks.get(img) === t && !!this.settings?.enabled;
  }

  private async request(img: HTMLImageElement, t: Track, refine: boolean): Promise<ClassifyResult> {
    const tag = __DEV__ ? img.dataset.tzTest : undefined;
    // blob: URLs belong to the page's origin — only the page context can read them.
    if (t.src.startsWith('blob:')) return this.client.classify(t.key, { dataUrl: extractPixels(img) }, refine, tag);
    const source: ImageSource = { url: t.src };
    try {
      return await this.client.classify(t.key, source, refine, tag);
    } catch (e) {
      if (!isFetchFailure(e)) throw e;
      // e.g. a CDN that demands the page's Referer. Works if the image is same-origin
      // or CORS-enabled; throws SecurityError if the canvas is tainted → stays blurred.
      return this.client.classify(t.key, { dataUrl: extractPixels(img) }, refine, tag);
    }
  }

  private pendingState(): State {
    return this.settings?.mode === 'fast' ? 'fast' : 'pending';
  }
}

/**
 * Cheap pre-layout check: tiny source, or explicit width/height attributes both under
 * MIN_SIDE. Rendered size is checked later from the IntersectionObserver rect (no
 * forced layout).
 */
function isTiny(img: HTMLImageElement): boolean {
  if (img.naturalWidth < MIN_SIDE || img.naturalHeight < MIN_SIDE) return true;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  return w > 0 && h > 0 && w < MIN_SIDE && h < MIN_SIDE;
}

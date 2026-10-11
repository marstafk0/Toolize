import type { ImageSource } from '../shared/messages';
import { decide, isExplicit, PRESETS, type ClassifyResult } from '../shared/policy';
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
  /** Dev timing: when it entered the queue. */
  queuedAt?: number;
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
      // Still loading and not laid out yet (no size until it decodes): its position is
      // not where it will end up, so "near the viewport" means nothing yet. Wait for
      // the load event, which queues it again.
      if (!(el as HTMLImageElement).complete && (rect.width === 0 || rect.height === 0)) return false;
      return true;
    },
  );

  constructor(
    private readonly client: ClassifyClient,
    private readonly stamper: Stamper,
    /** An image on this page was explicit (porn/hentai), keyed by URL hash. */
    private readonly onExplicit: (key: string) => void = () => {},
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

    // Size checks come before any cached verdict: an image classified while it was still
    // loading turns out to be an icon once decoded, and icons are never judged.
    if (img.complete) {
      if (img.naturalWidth === 0) return this.stamper.set(img, 'skip'); // broken: nothing to show
      if (isTiny(img)) return this.stamper.set(img, 'skip');
    }

    const known = this.client.cached(t.key);
    if (known) return this.apply(img, t, known);

    this.stamper.set(img, this.pendingState());
    if (!img.complete && !fetchableEarly(img)) {
      return; // the load/error event brings us back
    }
    // Still loading but the URL is certain: classify alongside the page's own download
    // instead of after it. Our fetch is the slowest step on real sites, so starting it
    // early takes it off the time the image sits blurred. The verdict is for this exact
    // URL, so applying it before the page has painted the image is safe.
    if (__DEV__) t.queuedAt ??= performance.now();
    this.queue.observe(img);
  }

  private async dispatch(img: HTMLImageElement): Promise<void> {
    const t = this.tracks.get(img);
    if (!t) return;
    try {
      const started = performance.now();
      const r = await this.request(img, t, false);
      if (__DEV__ && t.queuedAt !== undefined)
        console.debug(`[toolize-timing] queue ${Math.round(started - t.queuedAt)} rtt ${Math.round(performance.now() - started)}`);
      if (this.current(img, t)) this.apply(img, t, r);
    } catch (e) {
      // A request that fails after protection was switched off must not re-stamp it.
      if (!this.current(img, t)) return;
      // Started early and the fallback needs the decoded image: the load event retries.
      if (!img.complete) return;
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
    const thresholds = PRESETS[this.settings!.preset];
    const d = decide(r, thresholds);
    if (d === 'blocked' && isExplicit(r, thresholds)) this.onExplicit(t.key);
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

/**
 * Whether a still-loading image's URL is already the one that will be shown. With
 * srcset or <picture> the browser picks a candidate at load time, possibly a different
 * picture altogether (art direction), so those wait for the load event. blob: needs the
 * decoded element.
 */
function fetchableEarly(img: HTMLImageElement): boolean {
  const src = img.getAttribute('src');
  if (!src || img.hasAttribute('srcset') || img.parentElement?.localName === 'picture') return false;
  return /^https?:/.test(img.src);
}

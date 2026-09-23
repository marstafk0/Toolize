import { decide, PRESETS } from '../shared/policy';
import type { Settings } from '../shared/settings';
import type { ClassifyClient } from './client';

/** Backgrounds smaller than this are sprites, buttons and icons. */
const MIN_SIDE = 100;
/** Sampling grid across the viewport. */
const COLS = 9;
const ROWS = 6;
const SWEEP_DEBOUNCE_MS = 250;
/** Never sweep more often than this, however much the page churns. */
const MIN_SWEEP_GAP_MS = 500;
/** Elements inspected per sweep — a hard ceiling on the work a single sweep can do. */
const MAX_CANDIDATES = 200;

/**
 * CSS background images.
 *
 * There's no way to query "elements with a background-image", and walking every
 * element on every mutation is too expensive. Instead we sample a grid of points across
 * the viewport after scrolls and mutations, which finds exactly the large hero and
 * thumbnail backgrounds that matter and ignores the sprite sheets that don't.
 *
 * Unlike <img> and <video>, backgrounds are detect-then-hide, not safe-reveal: hiding
 * every background before classification would gut the layout of every site. Results
 * are cached by URL, so a given image only risks being seen once.
 *
 * Flagged elements have the background removed rather than blurred — a filter would
 * blur the element's text and children too, and adding a positioned overlay can break
 * page layout.
 */
export class BackgroundWatcher {
  private seen = new WeakMap<Element, string>();
  private settings: Settings | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private blocked = 0;

  constructor(
    private readonly client: ClassifyClient,
    private readonly roots: () => ShadowRoot[],
    private readonly onChange: () => void,
  ) {}

  get blockedCount(): number {
    return this.blocked;
  }

  setSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = s;
    if (!s.enabled) return this.revealAll();
    // Re-decide everything when the thresholds change (cached scores make this cheap).
    if (!prev?.enabled || prev.preset !== s.preset) this.seen = new WeakMap();
    this.schedule();
  }

  start(): void {
    addEventListener('scroll', () => this.schedule(), { passive: true, capture: true });
    addEventListener('resize', () => this.schedule(), { passive: true });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  schedule(): void {
    if (this.stopped || this.timer || !this.settings?.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const wait = Math.max(0, MIN_SWEEP_GAP_MS - (performance.now() - this.lastSweep));
      if (wait) return void setTimeout(() => this.schedule(), wait);
      // Hit-testing forces layout, so wait for an idle slot: scrolling stays smooth
      // even on a slow machine. The timeout keeps it from being starved outright.
      const run = () => {
        this.lastSweep = performance.now();
        this.sweep();
      };
      'requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 1500 }) : run();
    }, SWEEP_DEBOUNCE_MS);
  }

  private lastSweep = 0;

  private sweep(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scopes: (Document | ShadowRoot)[] = [document, ...this.roots()];
    const candidates = new Set<Element>();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const x = ((c + 0.5) * w) / COLS;
        const y = ((r + 0.5) * h) / ROWS;
        for (const scope of scopes) {
          // Top few elements at each point: the background often sits on an ancestor.
          for (const el of scope.elementsFromPoint(x, y).slice(0, 3)) candidates.add(el);
        }
      }
    }
    // Reading background-image costs a style recalc; measuring costs layout. Do the
    // cheap one first and only measure the handful of elements that have a background.
    let seenCount = 0;
    for (const el of candidates) {
      if (++seenCount > MAX_CANDIDATES) break;
      if (this.seen.get(el) === '') continue; // known to have no background
      void this.check(el);
    }
  }

  private async check(el: Element): Promise<void> {
    // Already hidden: our own `background-image: none` is what getComputedStyle now
    // reports, so re-reading it would look like "no background", reveal the element and
    // start a hide/reveal flicker loop. It stays hidden until invalidate() says
    // otherwise (the page changed the element's style or class).
    if (el.getAttribute('data-tz-bg') === 'blocked') return;
    const url = backgroundUrl(el);
    if (this.seen.get(el) === (url ?? '')) return;
    this.seen.set(el, url ?? '');
    if (!url) return this.reveal(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) return this.reveal(el);

    const key = this.client.key(url);
    try {
      const known = this.client.cached(key);
      const r = known ?? (await this.client.classify(key, { url }, false));
      if (this.seen.get(el) !== url || !this.settings?.enabled) return;
      const t = PRESETS[this.settings.preset];
      let d = decide(r, t);
      if (d === 'refine') d = decide(await this.client.classify(key, { url }, true), t);
      d === 'blocked' ? this.hide(el) : this.reveal(el);
    } catch (e) {
      // Fail safe: a background we couldn't classify is hidden, and losing a background
      // image costs the page far less than losing an <img>.
      this.hide(el);
      if (__DEV__) console.warn('[toolize] background classify failed', url.slice(0, 120), e);
    }
  }

  /** The page restyled a hidden element: let the next sweep judge it afresh. */
  invalidate(el: Element): void {
    this.seen.delete(el);
    this.reveal(el);
  }

  private hide(el: Element): void {
    if (el.getAttribute('data-tz-bg') === 'blocked') return;
    el.setAttribute('data-tz-bg', 'blocked');
    this.blocked++;
    this.onChange();
  }

  private reveal(el: Element): void {
    if (el.getAttribute('data-tz-bg') !== 'blocked') return;
    el.removeAttribute('data-tz-bg');
    this.blocked = Math.max(0, this.blocked - 1);
    this.onChange();
  }

  private revealAll(): void {
    for (const scope of [document, ...this.roots()]) {
      scope.querySelectorAll('[data-tz-bg]').forEach((el) => el.removeAttribute('data-tz-bg'));
    }
    this.blocked = 0;
    this.onChange();
  }
}

/** First real image layer of an element's background, ignoring gradients. */
function backgroundUrl(el: Element): string | null {
  const value = getComputedStyle(el).backgroundImage;
  if (!value || value === 'none') return null;
  for (const m of value.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
    const url = m[2];
    if (url && !url.startsWith('#')) return url;
  }
  return null;
}

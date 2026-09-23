/** Start work this far ahead of the viewport so reveals are ready on arrival. */
const PREFETCH_MARGIN = '1200px 600px';
/** Requests in flight per frame; the offscreen doc batches across them. */
const MAX_INFLIGHT = 8;

/**
 * Runs work for elements only once they come near the viewport, visible ones first.
 * An element that scrolls away before its turn is dropped from the queue, so a fast
 * scroll through a long feed doesn't queue up thousands of stale classifications.
 */
export class NearViewportQueue {
  private hot = new Set<Element>(); // in the viewport
  private warm = new Set<Element>(); // within the prefetch margin
  private active = 0;
  private stopped = false;

  private readonly io = new IntersectionObserver((entries) => this.onIntersect(entries), {
    rootMargin: PREFETCH_MARGIN,
  });

  /**
   * @param run       work to perform when the element is near the viewport
   * @param prefilter return false to drop the element without running (e.g. too small)
   */
  constructor(
    private readonly run: (el: Element) => Promise<void> | void,
    private readonly prefilter?: (el: Element, rect: DOMRectReadOnly) => boolean,
  ) {}

  observe(el: Element): void {
    if (!this.stopped) this.io.observe(el);
  }

  drop(el: Element): void {
    this.io.unobserve(el);
    this.hot.delete(el);
    this.warm.delete(el);
  }

  disconnect(): void {
    this.stopped = true;
    this.io.disconnect();
    this.hot.clear();
    this.warm.clear();
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    const vh = window.innerHeight;
    for (const e of entries) {
      const el = e.target;
      if (!e.isIntersecting) {
        this.hot.delete(el);
        this.warm.delete(el);
        continue;
      }
      if (this.prefilter && !this.prefilter(el, e.boundingClientRect)) {
        this.io.unobserve(el);
        continue;
      }
      const r = e.boundingClientRect;
      (r.bottom > 0 && r.top < vh ? this.hot : this.warm).add(el);
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < MAX_INFLIGHT && !this.stopped) {
      const el = first(this.hot) ?? first(this.warm);
      if (!el) return;
      this.drop(el);
      if (!el.isConnected) continue;
      this.active++;
      void Promise.resolve(this.run(el)).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

function first<T>(set: Set<T>): T | undefined {
  for (const v of set) return v;
  return undefined;
}

import blurCss from '../shared/blur.css';
import type { StatsReport } from '../shared/messages';
import type { Settings } from '../shared/settings';
import { BackgroundWatcher } from './backgrounds';
import { ClassifyClient } from './client';
import { ImageWatcher } from './images';
import { Stamper } from './state';
import { VideoWatcher } from './video';

const STATS_DEBOUNCE_MS = 750;

const OBSERVE_OPTS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'sizes', 'poster', 'style', 'class', 'data-tz', 'data-tz-shadow'],
};

/** Media events worth re-deciding on. `load` doesn't bubble, so these are capture-phase. */
const MEDIA_EVENTS = ['load', 'error', 'loadeddata', 'play', 'seeked', 'emptied', 'encrypted'];

/**
 * Discovery for one document (frame): finds media as it appears and routes it to the
 * image, video and background watchers, which share one classification client.
 *
 * Sources of media: the initial parse, DOM insertions, src/srcset swaps in virtualized
 * lists, lazy loads, shadow roots (open, closed and declarative), and same-origin
 * iframes (which run their own copy of this script).
 */
export class BlurEngine {
  private stopped = false;
  private roots: WeakRef<ShadowRoot>[] = [];
  private seenRoots = new WeakSet<ShadowRoot>();
  private sheet: CSSStyleSheet | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly client = new ClassifyClient();
  private readonly stamper = new Stamper(() => this.scheduleStats());
  private readonly images = new ImageWatcher(this.client, this.stamper);
  private readonly videos = new VideoWatcher(this.client, this.stamper);
  private readonly backgrounds = new BackgroundWatcher(
    this.client,
    () => this.liveRoots(),
    () => this.scheduleStats(),
  );

  private readonly mo = new MutationObserver((records) => this.onMutations(records));
  private readonly onMediaEvent = (e: Event): void => {
    const el = e.target as Element;
    if (el.localName === 'img') {
      if (e.type === 'load' || e.type === 'error') this.images.onLoad(el as HTMLImageElement);
    } else if (el.localName === 'video') {
      const video = el as HTMLVideoElement;
      // 'encrypted' means EME/DRM: the frames are unreadable by anyone, us included.
      if (e.type === 'encrypted') this.videos.onDrm(video);
      else if (e.type === 'play') this.videos.onPlay(video);
      else this.videos.consider(video);
    }
  };

  /** Starts observing immediately; classification waits for setSettings(). */
  start(): void {
    this.mo.observe(document, OBSERVE_OPTS);
    for (const type of MEDIA_EVENTS) document.addEventListener(type, this.onMediaEvent, true);
    this.backgrounds.start();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.sweepShadowRoots(document), { once: true });
    } else {
      this.sweepShadowRoots(document);
    }
  }

  stop(): void {
    this.stopped = true;
    this.mo.disconnect();
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, this.onMediaEvent, true);
    this.images.stop();
    this.videos.stop();
    this.backgrounds.stop();
  }

  setSettings(s: Settings): void {
    this.images.setSettings(s);
    this.videos.setSettings(s);
    this.backgrounds.setSettings(s);
    this.forEachMedia((el) =>
      el.localName === 'img' ? this.images.consider(el as HTMLImageElement) : this.videos.consider(el as HTMLVideoElement),
    );
  }

  isAlive(): boolean {
    return !this.stopped && !!chrome.runtime?.id && !this.client.orphaned;
  }

  // ------------------------------------------------------------------ discovery

  private onMutations(records: MutationRecord[]): void {
    for (const m of records) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === Node.ELEMENT_NODE) this.scanSubtree(n as Element);
        continue;
      }
      const el = m.target as Element;
      switch (m.attributeName) {
        case 'src':
        case 'srcset':
        case 'sizes':
          if (el.localName === 'img') this.images.markStale(el as HTMLImageElement);
          else if (el.localName === 'video') this.videos.consider(el as HTMLVideoElement);
          else if (el.localName === 'source' && el.parentElement?.localName === 'picture')
            el.parentElement.querySelectorAll('img').forEach((img) => this.images.markStale(img));
          else if (el.localName === 'source' && el.parentElement?.localName === 'video')
            this.videos.consider(el.parentElement as HTMLVideoElement);
          break;
        case 'poster':
          if (el.localName === 'video') this.videos.consider(el as HTMLVideoElement);
          break;
        case 'style':
        case 'class':
          // Could be a background swap. Re-sweeping is far cheaper than measuring every
          // element that changes class on a busy page.
          if (el.hasAttribute('data-tz-bg')) this.backgrounds.invalidate(el);
          this.backgrounds.schedule();
          break;
        case 'data-tz':
          this.stamper.restore(el); // our own writes land here too; restore() no-ops on those
          break;
        case 'data-tz-shadow':
          this.attachRoot(el);
          break;
      }
    }
  }

  private scanSubtree(el: Element): void {
    if (el.localName === 'img') this.images.consider(el as HTMLImageElement);
    else if (el.localName === 'video') this.videos.consider(el as HTMLVideoElement);
    if (el.hasAttribute('data-tz-shadow')) this.attachRoot(el);
    if (!el.firstElementChild) return;
    el.querySelectorAll('img').forEach((img) => this.images.consider(img));
    el.querySelectorAll('video').forEach((v) => this.videos.consider(v));
    el.querySelectorAll('[data-tz-shadow]').forEach((host) => this.attachRoot(host));
    this.backgrounds.schedule();
  }

  private attachRoot(host: Element): void {
    const root = shadowRootOf(host);
    if (!root || this.seenRoots.has(root)) return;
    this.seenRoots.add(root);
    this.roots.push(new WeakRef(root));
    // Roots the MAIN-world hook never saw (declarative shadow DOM, or pages open before
    // install) don't have the blur sheet yet.
    try {
      if (!this.sheet) {
        this.sheet = new CSSStyleSheet();
        this.sheet.replaceSync(blurCss);
      }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
    } catch {
      /* ignore */
    }
    this.mo.observe(root, OBSERVE_OPTS);
    for (const type of MEDIA_EVENTS) root.addEventListener(type, this.onMediaEvent, true); // events don't cross the boundary
    root.querySelectorAll('img').forEach((img) => this.images.consider(img));
    root.querySelectorAll('video').forEach((v) => this.videos.consider(v));
    root.querySelectorAll('[data-tz-shadow]').forEach((h) => this.attachRoot(h));
    this.backgrounds.schedule();
  }

  /** Finds shadow roots with no marker (declarative shadow DOM, pre-install pages). */
  private sweepShadowRoots(scope: Document | ShadowRoot): void {
    for (const el of scope.querySelectorAll('*')) {
      const root = shadowRootOf(el);
      if (root && !this.seenRoots.has(root)) {
        this.attachRoot(el);
        this.sweepShadowRoots(root);
      }
    }
    this.backgrounds.schedule();
  }

  private liveRoots(): ShadowRoot[] {
    const live: ShadowRoot[] = [];
    this.roots = this.roots.filter((ref) => {
      const root = ref.deref();
      if (root) live.push(root);
      return !!root;
    });
    return live;
  }

  private forEachMedia(fn: (el: Element) => void): void {
    for (const scope of [document, ...this.liveRoots()]) scope.querySelectorAll('img, video').forEach(fn);
  }

  // ------------------------------------------------------------------ stats

  private scheduleStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      if (this.stopped || !chrome.runtime?.id) return;
      const msg: StatsReport = {
        target: 'background',
        kind: 'stats',
        stats: this.stamper.stats(this.backgrounds.blockedCount),
      };
      chrome.runtime.sendMessage(msg).catch(() => {});
    }, STATS_DEBOUNCE_MS);
  }
}

/**
 * chrome.dom.openOrClosedShadowRoot only accepts HTML elements and throws on anything
 * else. A sweep over querySelectorAll('*') meets SVG on almost every page (YouTube is
 * full of it), and one throw ended the sweep, leaving every later root undiscovered.
 */
function shadowRootOf(el: Element): ShadowRoot | null {
  if (!(el instanceof HTMLElement)) return null;
  try {
    return chrome.dom.openOrClosedShadowRoot(el) as ShadowRoot | null;
  } catch {
    return null;
  }
}

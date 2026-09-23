import { decide, PRESETS } from '../shared/policy';
import type { Settings } from '../shared/settings';
import { ClassifyClient, isFetchFailure } from './client';
import type { Stamper, State } from './state';

/** How often each sampled video is classified, and how far it backs off when stable. */
const SAMPLE_MS = 1000;
const MAX_SAMPLE_MS = 4000;
/** Tick rate; each video is sampled on its own schedule. */
const TICK_MS = 500;
/**
 * Above this average round trip the classifier is the bottleneck (no GPU, busy
 * machine), so sample one video at a time and let images and backgrounds through.
 */
const SLOW_CLASSIFIER_MS = 400;
/** Blur if any of the last N frames was flagged. */
const WINDOW = 3;
/** Consecutive clean frames needed to reveal — stops borderline clips from strobing. */
const CLEAN_STREAK = 3;
/** Videos sampled at once, largest first. */
const MAX_CONCURRENT = 4;
const FRAME_MAX_SIDE = 448;
/** Videos smaller than this are decorative loops/backgrounds too small to read. */
const MIN_SIDE = 64;

interface Track {
  recent: boolean[];
  cleanStreak: number;
  drm: boolean;
  /** The offscreen whole-file path already ran (or failed) for this source. */
  fileTried: boolean;
  src: string;
  /** No more sampling: DRM, a whole-file verdict, or an unreadable source. */
  dead?: boolean;
  /** Last decision, so re-enabling protection doesn't re-sample from scratch. */
  verdict?: State;
  /** Current gap between samples (grows while the verdict stays stable). */
  every: number;
  nextAt: number;
}

/**
 * Video classification: samples frames from playing videos ~1/s and blurs on the
 * sliding window, pausing anything flagged.
 *
 * Pixels come from the page canvas (works for MSE/blob: streams, same-origin files and
 * CORS-enabled files). A cross-origin file without CORS taints that canvas, so the
 * offscreen document refetches the file and samples it there instead. DRM-protected
 * video can't be read at all — those are left alone, on the reasoning that a site
 * shipping Widevine is a streaming service, and actual adult sites are blocked at the
 * network layer before any of this runs.
 */
export class VideoWatcher {
  private tracks = new WeakMap<HTMLVideoElement, Track>();
  /** DRM can be signalled before we've even seen the element, so remember it here. */
  private drm = new WeakSet<HTMLVideoElement>();
  private candidates = new Set<HTMLVideoElement>();
  private settings: Settings | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = new WeakSet<HTMLVideoElement>();

  private readonly io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) this.candidates.add(v);
      else this.candidates.delete(v);
    }
  });

  constructor(
    private readonly client: ClassifyClient,
    private readonly stamper: Stamper,
  ) {}

  setSettings(s: Settings): void {
    this.settings = s;
    if (s.enabled && !this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (!s.enabled && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.io.disconnect();
    this.candidates.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called on discovery and on src / loadeddata / play / seeked / emptied. */
  consider(video: HTMLVideoElement): void {
    const s = this.settings;
    if (!s) return;
    if (!s.enabled) {
      this.candidates.delete(video);
      return this.stamper.set(video, 'off');
    }

    let t = this.tracks.get(video);
    const src = video.currentSrc || video.src;
    if (!t || t.src !== src) {
      t = { recent: [], cleanStreak: 0, drm: false, fileTried: false, src, every: SAMPLE_MS, nextAt: 0 };
      this.tracks.set(video, t);
      this.io.observe(video);
      this.stamper.set(video, this.pendingState());
    }

    if (video.mediaKeys || this.drm.has(video)) return this.onDrm(video);
    // Coming back from disabled: restore the last verdict rather than re-sampling.
    if (this.stamper.get(video) === 'off') this.stamper.set(video, t.verdict ?? this.pendingState());
    if (t.dead) return;

    // A clean poster reveals the frame shown before playback; frames take over on play.
    if (video.poster && this.stamper.get(video) !== 'blocked') void this.checkPoster(video, t);
  }

  /** Playback started again after a block: re-arm and let frames decide. */
  onPlay(video: HTMLVideoElement): void {
    const t = this.tracks.get(video);
    if (!t || t.dead || !this.settings?.enabled) return;
    // New content: sample at full rate again.
    t.every = SAMPLE_MS;
    t.nextAt = 0;
    if (this.stamper.get(video) === 'blocked') {
      t.recent = [];
      t.cleanStreak = 0;
      this.stamper.set(video, this.pendingState());
    }
  }

  onDrm(video: HTMLVideoElement): void {
    this.drm.add(video);
    if (!this.settings?.enabled) return;
    const t = this.tracks.get(video);
    if (t) {
      t.drm = true;
      t.dead = true;
      t.verdict = 'skip';
    }
    this.candidates.delete(video);
    this.stamper.set(video, 'skip');
  }

  private async checkPoster(video: HTMLVideoElement, t: Track): Promise<void> {
    try {
      const key = this.client.key(video.poster);
      const r = this.client.cached(key) ?? (await this.client.classify(key, { url: video.poster }, false));
      if (this.tracks.get(video) !== t) return;
      const d = decide(r, PRESETS[this.settings!.preset]);
      if (d === 'blocked') this.stamper.set(video, 'blocked');
      else if (d === 'clean' && video.paused && !t.recent.length) this.stamper.set(video, 'clean');
    } catch {
      /* poster is a hint, not a verdict */
    }
  }

  /** One pass over the visible, playing videos that are due a sample. */
  private async tick(): Promise<void> {
    if (document.hidden || !this.settings?.enabled) return;
    const now = performance.now();
    // When the classifier is saturated, sample one video at a time: live frames must
    // not starve the images and backgrounds waiting behind them.
    const budget = this.avgLatency > SLOW_CLASSIFIER_MS ? 1 : MAX_CONCURRENT;
    const live = [...this.candidates]
      .filter((v) => v.isConnected && !v.paused && v.readyState >= 2 && !this.busy.has(v))
      .filter((v) => v.videoWidth >= MIN_SIDE && v.videoHeight >= MIN_SIDE)
      .filter((v) => {
        const t = this.tracks.get(v);
        return t && !t.dead && now >= t.nextAt;
      })
      .sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)
      .slice(0, budget);
    await Promise.all(live.map((v) => this.sample(v)));
  }

  /** Rolling average round trip of a frame classification. */
  private avgLatency = 0;

  private noteLatency(ms: number): void {
    this.avgLatency = this.avgLatency ? this.avgLatency * 0.7 + ms * 0.3 : ms;
  }

  private async sample(video: HTMLVideoElement): Promise<void> {
    const t = this.tracks.get(video);
    if (!t) return;
    this.busy.add(video);
    const started = performance.now();
    try {
      const tag = __DEV__ ? video.dataset.tzTest : undefined;
      let frame: string;
      try {
        frame = grabFrame(video);
      } catch {
        // Tainted canvas: one whole-file verdict stands in for the frame window.
        const flagged = await this.classifyWholeFile(video, t, tag);
        if (this.tracks.get(video) === t) this.setVerdict(video, t, flagged ? 'blocked' : 'clean');
        return;
      }
      const r = await this.client.classifyFrame(frame, tag);
      if (this.tracks.get(video) !== t) return;
      // A frame can't be re-scored on tiles after the fact, so treat 'refine'
      // (borderline) as flagged and let the clean streak reveal it again.
      this.record(video, t, decide(r, PRESETS[this.settings!.preset]) !== 'clean');
    } catch (e) {
      if (this.tracks.get(video) === t) {
        t.dead = true;
        this.stamper.set(video, 'error');
      }
      if (__DEV__) console.warn('[toolize] video sample failed', t.src.slice(0, 120), e);
    } finally {
      this.busy.delete(video);
      this.noteLatency(performance.now() - started);
      t.nextAt = performance.now() + t.every;
    }
  }

  /** Cross-origin file without CORS: let the offscreen doc fetch and sample it. */
  private async classifyWholeFile(video: HTMLVideoElement, t: Track, tag?: string): Promise<boolean> {
    if (t.drm) {
      this.onDrm(video);
      return false;
    }
    if (t.fileTried || !/^https?:/.test(t.src)) throw new Error('no readable pixels');
    t.fileTried = true;
    const key = this.client.key(`video:${t.src}`);
    try {
      const r = await this.client.classify(key, { videoUrl: t.src }, false, tag);
      t.dead = true; // whole-file verdict: no point sampling further
      return decide(r, PRESETS[this.settings!.preset]) !== 'clean';
    } catch (e) {
      if (isFetchFailure(e)) throw new Error(`video fetch failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private record(video: HTMLVideoElement, t: Track, flagged: boolean): void {
    t.recent.push(flagged);
    if (t.recent.length > WINDOW) t.recent.shift();
    t.cleanStreak = flagged ? 0 : t.cleanStreak + 1;

    if (t.recent.includes(true)) {
      t.every = SAMPLE_MS; // something was flagged: watch it closely again
      this.setVerdict(video, t, 'blocked');
    } else if (t.cleanStreak >= CLEAN_STREAK) {
      // Stable and clean: ease off, so a long video doesn't classify forever at 1/s.
      t.every = Math.min(MAX_SAMPLE_MS, t.every * 1.5);
      this.setVerdict(video, t, 'clean');
    }
  }

  private setVerdict(video: HTMLVideoElement, t: Track, verdict: State): void {
    t.verdict = verdict;
    this.stamper.set(video, verdict);
    if (verdict === 'blocked') video.pause();
  }

  private pendingState(): State {
    return this.settings?.mode === 'fast' ? 'fast' : 'pending';
  }
}

/** Throws SecurityError when the video taints the canvas (cross-origin, no CORS). */
function grabFrame(video: HTMLVideoElement): string {
  const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

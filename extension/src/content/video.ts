import { decide, isObviouslyExplicit, PRESETS, type ClassifyResult } from '../shared/policy';
import type { Frame, VerdictDecision } from '../shared/verdicts';
import { channelKey, isYouTube, trustedSet } from '../shared/channels';
import { isLiveSite, type Settings } from '../shared/settings';
import { ClassifyClient, isFetchFailure } from './client';
import type { Stamper, State } from './state';
import type { VerdictLog } from './verdicts';

/** How often each sampled video is classified, and how far it backs off when stable. */
const SAMPLE_MS = 1000;
const MAX_SAMPLE_MS = 4000;
/**
 * Gap between samples until a video has its first verdict. A new video is blurred
 * until CLEAN_STREAK frames come back clean; at the steady 1/s that is 3-4s of blur on
 * every YouTube hover preview, which reads as the blur hanging.
 */
const FIRST_SAMPLE_MS = 250;
/** Tick rate; each video is sampled on its own schedule. */
const TICK_MS = 250;
/** Consecutive failed samples before an unverified video is blurred. */
const MAX_FAILURES = 3;
/** Wait after a failed sample. Failures are retried, never final. */
const RETRY_MS = 5000;
/**
 * Above this average round trip the classifier is the bottleneck (no GPU, busy
 * machine), so sample one video at a time and let images and backgrounds through.
 */
const SLOW_CLASSIFIER_MS = 400;
/**
 * Sliding window of frame results. Before a video is first shown, any doubtful frame
 * keeps it blurred (safe reveal). Once it is playing in the clear, one odd frame must
 * not blur it out of nowhere: it takes FLAGGED_TO_BLUR flagged frames in the window,
 * or a single obviously explicit one.
 */
const WINDOW = 3;
const FLAGGED_TO_BLUR = 2;
/** Longest a YouTube video waits for its player to name the channel (trusted channels). */
const CHANNEL_WAIT_MS = 1500;
/** Consecutive clean frames needed to reveal — stops borderline clips from strobing. */
const CLEAN_STREAK = 3;
/** Videos sampled at once. */
const MAX_CONCURRENT = 4;
const FRAME_MAX_SIDE = 448;
/** Videos smaller than this are decorative loops/backgrounds too small to read. */
const MIN_SIDE = 64;

interface Track {
  recent: Frame[];
  cleanStreak: number;
  drm: boolean;
  /** The offscreen whole-file path returned a definitive verdict for this source. */
  fileTried: boolean;
  src: string;
  /** No more sampling: DRM, a whole-file verdict, or an unreadable source. */
  dead?: boolean;
  /** Last decision, so re-enabling protection doesn't re-sample from scratch. */
  verdict?: State;
  revealed?: boolean;
  /** Current gap between samples (grows while the verdict stays stable). */
  every: number;
  nextAt: number;
  /** Failed samples in a row; reset by any success. */
  failures: number;
  /** currentTime of the last frame classified while paused, so a still is checked once. */
  stillAt?: number;
  /**
   * A live stream: never paused. Pausing a live stream throws it behind the live edge
   * (or stalls it), and a false positive would then repeat on every resume.
   */
  live?: boolean;
  lastDuration?: number;
  /** Exempt: a live stream on a live-stream site (allowLiveStreams), or a trusted channel. */
  exempt?: boolean;
  /** When the track started, to bound the wait for YouTube to name the channel. */
  seenAt: number;
  generation: number;
  preset: Settings['preset'];
  posterSrc?: string;
  posterVerdict?: VerdictDecision;
  pausedByUs?: boolean;
}

/** The video's pixels can't be read at all; retrying won't change that. */
class Unreadable extends Error {}

/**
 * Video classification: samples frames from playing videos ~1/s and blurs on the
 * sliding window, pausing confirmed hits outside YouTube and live streams.
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
  private generation = 0;
  private inFlight = 0;

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
    private readonly verdicts: VerdictLog,
  ) {}

  setSettings(s: Settings): void {
    const prev = this.settings;
    this.generation++;
    this.settings = s;
    for (const v of this.candidates) {
      const t = this.tracks.get(v);
      if (!t) continue;
      t.posterSrc = undefined;
      if (!s.enabled) this.resume(v, t);
      if ((!prev?.enabled && s.enabled) || prev?.preset !== s.preset) this.reset(t, prev?.preset === s.preset);
    }
    if (s.enabled && !this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (!s.enabled && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.generation++;
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
      const t = this.tracks.get(video);
      if (t) this.resume(video, t);
      return this.stamper.set(video, 'off');
    }

    lockDown(video);
    let t = this.tracks.get(video);
    const src = video.currentSrc || video.src;
    if (!t || t.src !== src) {
      t = { recent: [], cleanStreak: 0, drm: false, fileTried: false, src, every: FIRST_SAMPLE_MS, nextAt: 0, failures: 0, seenAt: performance.now(), generation: 0, preset: s.preset, pausedByUs: t?.pausedByUs };
      this.tracks.set(video, t);
      this.io.observe(video);
      this.stamper.set(video, this.pendingState());
    }

    if (video.mediaKeys || this.drm.has(video)) return this.onDrm(video);
    // Keep viewport membership across disable, but judge restored verdicts afresh.
    if (this.stamper.get(video) === 'off' || t.preset !== s.preset) {
      this.reset(t, t.preset === s.preset);
      this.stamper.set(video, t.verdict ?? this.pendingState());
    }
    t.preset = s.preset;

    if (this.tiny(video)) {
      if (this.stamper.get(video) !== 'skip') t.generation++;
      return this.stamper.set(video, 'skip');
    }
    if (!t.exempt && this.stamper.get(video) === 'skip') {
      this.reset(t);
      this.stamper.set(video, this.pendingState());
    }
    if (t.dead) return;

    // A clean poster reveals the frame shown before playback; frames take over on play.
    if ((t.posterSrc ?? '') !== video.poster) {
      t.posterSrc = video.poster;
      t.posterVerdict = undefined;
      if (!t.recent.length) {
        this.stamper.set(video, this.pendingState());
      }
    }
    if (video.poster && !t.recent.length) void this.checkPoster(video, t);
  }

  /** Playback started again after a block: re-arm and let frames decide. */
  onPlay(video: HTMLVideoElement): void {
    const t = this.tracks.get(video);
    if (t) t.pausedByUs = false;
    if (!t || t.dead || !this.settings?.enabled) return;
    t.nextAt = 0;
    if (this.stamper.get(video) === 'blocked') {
      t.recent = [];
      t.cleanStreak = 0;
      this.stamper.set(video, this.pendingState());
    }
    // New content: sample at full rate again, and quickly if there's no verdict yet.
    t.every = this.stamper.get(video) === 'clean' ? SAMPLE_MS : FIRST_SAMPLE_MS;
  }

  onDrm(video: HTMLVideoElement): void {
    this.drm.add(video);
    if (!this.settings?.enabled) return;
    const t = this.tracks.get(video);
    if (t) {
      t.generation++;
      t.drm = true;
      t.dead = true;
      t.verdict = 'skip';
    }
    this.candidates.delete(video);
    this.stamper.set(video, 'skip');
  }

  private async checkPoster(video: HTMLVideoElement, t: Track): Promise<void> {
    const generation = this.generation;
    const revision = t.generation;
    const posterSrc = video.poster;
    try {
      const key = this.client.key(posterSrc);
      const r = this.client.cached(key) ?? (await this.client.classify(key, { url: posterSrc }, false));
      if (!this.current(video, t, generation, revision) || video.poster !== posterSrc || t.posterSrc !== posterSrc || t.recent.length) return;
      const d = decide(r, PRESETS[this.settings!.preset]);
      if (d !== 'refine' && video.paused) {
        this.stamper.set(video, d);
        if (t.posterVerdict !== d) this.verdicts.record('poster', d, r, this.settings!.preset);
        t.posterVerdict = d;
      }
    } catch {
      /* poster is a hint, not a verdict */
    }
  }

  /**
   * One pass over the visible videos that are due a sample: playing ones on their
   * schedule, paused ones once per still frame (otherwise a video paused before its
   * verdict, like a hover preview or a player that didn't autoplay, stays blurred).
   */
  private async tick(): Promise<void> {
    if (document.hidden || !this.settings?.enabled) return;
    const waitForChannel = this.exempt();
    const now = performance.now();
    // When the classifier is saturated, sample one video at a time: live frames must
    // not starve the images and backgrounds waiting behind them.
    const budget = this.avgLatency > SLOW_CLASSIFIER_MS ? 1 : MAX_CONCURRENT;
    for (const v of this.candidates) if (this.tiny(v)) this.stamper.set(v, 'skip');
    const live = [...this.candidates]
      .filter((v) => v.isConnected && v.readyState >= 2 && !this.busy.has(v))
      .filter((v) => !this.tiny(v))
      .filter((v) => {
        const t = this.tracks.get(v);
        if (!t || t.dead || t.exempt || now < t.nextAt) return false;
        // With trusted channels set, don't judge a YouTube video before its player has
        // said whose it is: a first flagged frame would pause a trusted Short.
        if (waitForChannel && !v.hasAttribute('data-tz-author') && now - t.seenAt < CHANNEL_WAIT_MS) return false;
        return !v.paused || t.stillAt !== v.currentTime;
      })
      .sort((a, b) => {
        const ta = this.tracks.get(a)!;
        const tb = this.tracks.get(b)!;
        return Number(!!ta.verdict) - Number(!!tb.verdict) || ta.nextAt - tb.nextAt ||
          b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight;
      })
      .slice(0, Math.max(0, budget - this.inFlight));
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
    const generation = this.generation;
    const revision = t.generation;
    this.busy.add(video);
    this.inFlight++;
    const started = performance.now();
    let failed = false;
    this.noteDuration(video, t);
    try {
      const tag = __DEV__ ? video.dataset.tzTest : undefined;
      const at = __DEV__ ? video.currentTime : undefined;
      let frame: string;
      try {
        frame = grabFrame(video);
      } catch {
        // Tainted canvas: one whole-file verdict stands in for the frame window.
        const r = await this.classifyWholeFile(video, t, generation, revision, tag);
        if (r && this.current(video, t, generation, revision)) {
          const decision = decide(r, PRESETS[this.settings!.preset]) === 'clean' ? 'clean' : 'blocked';
          this.setVerdict(video, t, decision, r);
        }
        return;
      }
      const still = video.paused ? video.currentTime : undefined;
      const r = await this.client.classifyFrame(frame, tag);
      if (!this.current(video, t, generation, revision)) return;
      t.failures = 0;
      // A frame can't be re-scored on tiles after the fact, so 'refine' (borderline)
      // is doubtful: enough to keep a video hidden, not enough to hide a shown one.
      const th = PRESETS[this.settings!.preset];
      // Borderline safety alone is noisy on ordinary video, and treating it as
      // doubtful strands new previews behind the three-clean-frame requirement.
      // Keep stronger safety hits and NSFWJS-supported hits in the normal window;
      // image policy and the NSFWJS-only fallback retain their existing thresholds.
      const nsfw = r.whole.porn + r.whole.hentai + r.whole.sexy;
      const startup = __DEV__ && !t.revealed && t.verdict !== 'clean';
      const safetyNoise = r.safety !== undefined && (startup
        ? r.safety <= 0.9 && nsfw <= 0.15
        : r.safety <= 0.7 && nsfw <= 0.3);
      const decision = decide(safetyNoise ? { ...r, safety: 0 } : r, th);
      const result: Frame = decision === 'clean' ? 'clean' : decision === 'refine' ? 'doubtful' : 'flagged';
      const obvious = isObviouslyExplicit(r, th);
      if (still !== undefined) this.recordStill(video, t, still, result, obvious, r);
      else this.record(video, t, result, obvious, r);
      // Numeric diagnostics only: never log a frame's pixels or source. This entire
      // branch is removed from production; the playback harness listens to debug.
      if (__DEV__) console.debug('[toolize:video-frame]', JSON.stringify({
        t: Date.now(), at, safety: r.safety,
        porn: r.whole.porn, hentai: r.whole.hentai, sexy: r.whole.sexy, neutral: r.whole.neutral,
        frame: result, obvious, window: [...t.recent], verdict: t.verdict,
      }));
    } catch (e) {
      if (this.current(video, t, generation, revision)) {
        if (e instanceof Unreadable) {
          t.dead = true;
          this.stamper.set(video, 'error');
        } else {
          // Transient (the classifier restarting, a dropped message). One bad sample
          // must not blur a long video or a live stream for good: keep the current
          // verdict, blur only after repeated failures, and keep trying either way.
          failed = true;
          if (++t.failures >= MAX_FAILURES) this.stamper.set(video, 'error');
        }
      }
      if (__DEV__) console.warn('[toolize] video sample failed', t.src.slice(0, 120), e);
    } finally {
      this.busy.delete(video);
      this.inFlight--;
      this.noteLatency(performance.now() - started);
      if (this.current(video, t, generation, revision)) t.nextAt = performance.now() + (failed ? RETRY_MS : t.every);
    }
  }

  /** Cross-origin file without CORS: let the offscreen doc fetch and sample it. */
  private async classifyWholeFile(video: HTMLVideoElement, t: Track, generation: number, revision: number, tag?: string): Promise<ClassifyResult | null> {
    if (t.drm) {
      this.onDrm(video);
      return null;
    }
    if (t.fileTried || !/^https?:/.test(t.src)) throw new Unreadable('no readable pixels');
    const key = this.client.key(`video:${t.src}`);
    try {
      let r = await this.client.classify(key, { videoUrl: t.src }, false, tag);
      if (!this.current(video, t, generation, revision)) return null;
      if (decide(r, PRESETS[this.settings!.preset]) === 'refine') {
        r = await this.client.classify(key, { videoUrl: t.src }, true, tag);
        if (!this.current(video, t, generation, revision)) return null;
      }
      t.fileTried = true;
      t.failures = 0;
      t.dead = true; // whole-file verdict: no point sampling further
      return r;
    } catch (e) {
      if (isFetchFailure(e)) throw new Error(`video fetch failed: ${(e as Error).message}`);
      throw e;
    }
  }

  /**
   * With allowLiveStreams on, live video on the live-stream sites is left alone: shown,
   * never sampled or paused. Re-checked every tick, since YouTube reuses one <video>
   * as you move between a stream and a regular video.
   */
  /**
   * Live streams (allowLiveStreams) and trusted YouTube channels are left alone.
   * Returns whether trusted channels apply here (so sampling can wait for the channel).
   */
  private exempt(): boolean {
    const allow = !!this.settings?.allowLiveStreams && isLiveSite(location.hostname);
    const trusted = isYouTube(location.hostname) ? trustedSet(this.settings?.trustedChannels) : null;
    for (const v of this.candidates) {
      const t = this.tracks.get(v);
      if (!t) continue;
      // The channel comes from YouTube's player, mirrored by the MAIN-world hook.
      const exempt =
        (allow && isLive(v)) || (!!trusted?.size && trusted.has(channelKey(v.getAttribute('data-tz-author') ?? '')));
      if (exempt) {
        if (!t.exempt) t.generation++;
        this.resume(v, t);
        t.exempt = true;
        t.verdict = 'skip';
        this.stamper.set(v, 'skip'); // no-op when already skip
      } else if (t.exempt) {
        t.exempt = false;
        // Back to a normal video: judge it from scratch.
        this.reset(t);
        this.stamper.set(v, this.pendingState());
      }
    }
    return !!trusted?.size;
  }

  /**
   * A live stream's duration is Infinity (HLS) or keeps growing as the live edge moves
   * (YouTube's MSE player). A video on demand has a fixed one.
   */
  private noteDuration(video: HTMLVideoElement, t: Track): void {
    const d = video.duration;
    if (isLive(video)) t.live = true;
    else if (!video.paused && t.lastDuration !== undefined && d > t.lastDuration + 0.5) t.live = true;
    if (Number.isFinite(d)) t.lastDuration = d;
  }

  /**
   * A paused frame doesn't change, so it is classified once. The same rule as for
   * playing video: before a video is shown anything doubtful keeps it hidden; once it
   * has been shown clean, a single still over the threshold (a seek landing on a
   * misjudged frame) is not enough — it takes two flagged stills, or an obvious one.
   */
  private recordStill(video: HTMLVideoElement, t: Track, at: number, frame: Frame, obvious: boolean, r: ClassifyResult): void {
    t.stillAt = at;
    t.recent.push(frame);
    if (t.recent.length > WINDOW) t.recent.shift();
    const shown = t.verdict === 'clean';
    const flagged = t.recent.filter((f) => f === 'flagged').length;
    const blur = obvious || (shown ? flagged >= FLAGGED_TO_BLUR : frame !== 'clean');
    t.cleanStreak = blur ? 0 : CLEAN_STREAK;
    this.setVerdict(video, t, blur ? 'blocked' : 'clean', r, false, frame, obvious); // already paused
  }

  private record(video: HTMLVideoElement, t: Track, frame: Frame, obvious: boolean, r: ClassifyResult): void {
    t.recent.push(frame);
    if (t.recent.length > WINDOW) t.recent.shift();
    t.cleanStreak = frame === 'clean' ? t.cleanStreak + 1 : 0;

    const flagged = t.recent.filter((f) => f === 'flagged').length;
    const confirmed = obvious || flagged >= FLAGGED_TO_BLUR;
    const shown = t.verdict === 'clean';
    // Not shown yet: anything doubtful keeps it hidden. But only a confirmed hit pauses
    // it — a paused video yields no new frames, so a doubtful one could never clear
    // itself (Shorts sat blurred and paused for good).
    const blur = confirmed || (!shown && t.recent.some((f) => f !== 'clean'));
    if (frame !== 'clean') t.every = SAMPLE_MS; // something was off: look again soon
    if (blur) {
      this.setVerdict(video, t, 'blocked', r, confirmed, frame, obvious);
    } else if (t.cleanStreak >= CLEAN_STREAK || t.recent.every((f) => f === 'clean')) {
      // A streak only matters after something was off; a video that has looked clean
      // from its first frame is shown straight away, like an image. Then ease off, so a
      // long video doesn't classify forever at 1/s.
      t.every = Math.min(MAX_SAMPLE_MS, Math.max(SAMPLE_MS, t.every * 1.5));
      this.setVerdict(video, t, 'clean', r, false, frame, obvious);
    }
  }

  private setVerdict(
    video: HTMLVideoElement, t: Track, verdict: VerdictDecision, r: ClassifyResult,
    pause = verdict === 'blocked', frame?: Frame, obvious = false,
  ): void {
    if (t.exempt) return; // a sample that was already in flight when the exemption began
    if (t.verdict !== verdict) {
      // Allocate the diagnostic snapshot only on transitions, never on stable samples.
      const frameInfo = frame ? { frame, obvious, window: [...t.recent] } : undefined;
      let why: string | undefined;
      if (frame) {
        const flagged = t.recent.filter((f) => f === 'flagged').length;
        why = verdict === 'clean' ? (video.paused ? 'clean paused frame' : `${t.cleanStreak} consecutive clean frames`)
          : obvious ? 'obviously explicit frame'
          : flagged >= FLAGGED_TO_BLUR ? `${flagged} flagged of last ${t.recent.length} frames`
          : 'flagged or doubtful frame before clean reveal';
      }
      this.verdicts.record('video', verdict, { ...r, width: video.videoWidth, height: video.videoHeight }, this.settings!.preset, frameInfo, why);
    }
    if (verdict === 'clean') t.revealed = true;
    t.verdict = verdict;
    this.stamper.set(video, verdict);
    // YouTube is never paused: its players don't recover well from being paused under
    // them, and a wrong pause there (a cooking video) cost more than the blur alone.
    if (verdict === 'blocked' && pause && !t.live && !isYouTube(location.hostname) && !video.paused) {
      t.pausedByUs = true;
      video.pause();
    }
  }

  private current(video: HTMLVideoElement, t: Track, generation: number, revision: number): boolean {
    return !!this.settings?.enabled && this.generation === generation && this.tracks.get(video) === t &&
      t.generation === revision && !t.exempt;
  }

  private resume(video: HTMLVideoElement, t: Track): void {
    if (t.pausedByUs && video.paused) void video.play().catch(() => {});
    t.pausedByUs = false;
  }

  private reset(t: Track, restore = false): void {
    t.generation++;
    t.recent = [];
    t.cleanStreak = 0;
    t.stillAt = undefined;
    t.nextAt = 0;
    t.every = FIRST_SAMPLE_MS;
    t.posterSrc = undefined;
    t.posterVerdict = undefined;
    t.fileTried = false;
    t.dead = t.drm;
    if (!restore) {
      t.verdict = undefined;
      t.revealed = false;
    }
  }

  private tiny(video: HTMLVideoElement): boolean {
    return video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0 &&
      video.videoWidth < MIN_SIDE && video.videoHeight < MIN_SIDE;
  }

  private pendingState(): State {
    return this.settings?.mode === 'fast' ? 'fast' : 'pending';
  }
}

/**
 * Live, as far as the page can tell: HLS/MSE live streams report an infinite duration
 * (Twitch, Kick, most players); YouTube's doesn't, so its player's own answer is
 * mirrored onto the element by the MAIN-world hook.
 */
function isLive(video: HTMLVideoElement): boolean {
  return video.duration === Infinity || video.hasAttribute('data-tz-live');
}

/**
 * Picture-in-Picture and remote playback show the video outside the page, where the
 * blur can't follow. The JS API is already refused in the MAIN world; the attributes
 * are what the browser's own menus (right-click, media controls) check.
 */
function lockDown(video: HTMLVideoElement): void {
  if (!video.hasAttribute('disablepictureinpicture')) video.setAttribute('disablepictureinpicture', '');
  if (!video.hasAttribute('disableremoteplayback')) video.setAttribute('disableremoteplayback', '');
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

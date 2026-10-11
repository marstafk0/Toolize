import { isLearningVideo, looksLikeBot, type YouTubeVideoMeta } from '../shared/feeds';
import type { Settings } from '../shared/settings';

/**
 * YouTube comments: where they show (settings.youtubeComments), and protection from
 * the porn-spam bots in them, which applies wherever comments are visible.
 *
 * The page state lives on <html data-tz-yt-comments>:
 *   shown          comments visible
 *   entertainment  hidden, "learning" mode and this isn't a how-to video
 *   hidden         hidden everywhere
 *   pending        hidden until we know what the video is (fail safe)
 */

const STATE_ATTR = 'data-tz-yt-comments';
/** Set by the MAIN-world hook from the player's own response: id, title, category. */
const META_ATTR = 'data-tz-yt-meta';
const BOT_ATTR = 'data-tz-bot';

const HIDDEN = 'html:not([data-tz-yt-comments="shown"])';
const COMMENT = ':is(ytd-comment-view-model, ytd-comment-renderer)';

const CSS = `
${HIDDEN} ytd-comments > * { display: none !important; }
${HIDDEN} ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"],
${HIDDEN} ytd-shorts #comments-button { display: none !important; }
html[data-tz-yt-comments="entertainment"] ytd-comments::before,
html[data-tz-yt-comments="hidden"] ytd-comments::before {
  display: block; padding: 16px 0; font: 14px Roboto, Arial, sans-serif; color: var(--yt-spec-text-secondary, #888);
}
html[data-tz-yt-comments="entertainment"] ytd-comments::before {
  content: "Comments are hidden on entertainment videos. They show on how-to and learning videos.";
}
html[data-tz-yt-comments="hidden"] ytd-comments::before { content: "Comments are hidden."; }

/* Bots lure with a sexual avatar and "look at my profile". No avatars, no way through. */
${COMMENT} #author-thumbnail img { visibility: hidden !important; }
${COMMENT} #author-thumbnail yt-img-shadow { background: rgba(128, 128, 128, .3) !important; border-radius: 50%; }
${COMMENT} :is(#author-thumbnail, #author-text, ytd-channel-name, a[href^="/@"], a[href^="/channel/"], a[href^="/c/"],
  a[href^="/user/"], a[href*="/redirect"], a[href^="http"]:not([href*="youtube.com/watch"]):not([href^="https://youtu.be/"])) {
  pointer-events: none !important; cursor: default !important;
}
[${BOT_ATTR}] { display: none !important; }
`;

export class YouTubeGuard {
  private readonly style = document.createElement('style');
  private settings: Settings | null = null;
  private readonly seen = new WeakMap<Element, string>();
  private botsHidden = 0;
  private timer = 0;

  constructor() {
    this.style.dataset.toolize = 'youtube';
    this.style.textContent = CSS;
  }

  start(): void {
    this.update();
    this.timer = setInterval(() => this.update(), 300);
  }

  stop(): void {
    clearInterval(this.timer);
    this.style.remove();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.update();
  }

  /** For tests and diagnostics. */
  get hiddenBots(): number {
    return this.botsHidden;
  }

  private update(): void {
    const html = document.documentElement;
    if (!this.style.isConnected) (document.head ?? html).append(this.style);
    const state = this.state();
    if (html.getAttribute(STATE_ATTR) !== state) html.setAttribute(STATE_ATTR, state);
    if (state === 'shown') this.scanForBots();
  }

  private state(): 'shown' | 'entertainment' | 'hidden' | 'pending' {
    const mode = this.settings?.youtubeComments;
    if (!mode) return 'pending';
    if (mode === 'show') return 'shown';
    if (mode === 'hide') return 'hidden';

    // learning
    if (location.pathname.startsWith('/shorts/')) return 'entertainment';
    if (location.pathname !== '/watch') return 'entertainment'; // posts, channel pages
    const id = new URLSearchParams(location.search).get('v');
    const meta = this.meta();
    if (!id || meta?.id !== id) return 'pending'; // previous video's answer, or none yet
    return isLearningVideo(meta) ? 'shown' : 'entertainment';
  }

  private meta(): YouTubeVideoMeta | null {
    try {
      return JSON.parse(document.documentElement.getAttribute(META_ATTR) ?? 'null') as YouTubeVideoMeta | null;
    } catch {
      return null;
    }
  }

  /** Hides bot comments. A top-level bot takes its whole thread (the replies are its friends). */
  private scanForBots(): void {
    for (const el of document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')) {
      const author = [
        el.querySelector('#author-thumbnail-button')?.getAttribute('aria-label'),
        el.querySelector('#author-text')?.textContent,
        el.querySelector('ytd-channel-name')?.textContent,
      ].join(' ');
      const text = el.querySelector('#content-text')?.textContent ?? '';
      const sig = `${author}\n${text}`;
      if (this.seen.get(el) === sig) continue; // YouTube recycles nodes, so key on content
      this.seen.set(el, sig);

      const thread = el.closest('ytd-comment-thread-renderer');
      const target = thread && !el.closest('ytd-comment-replies-renderer') ? thread : el;
      const bot = looksLikeBot(author, text);
      if (bot && !target.hasAttribute(BOT_ATTR)) this.botsHidden++;
      target.toggleAttribute(BOT_ATTR, bot);
    }
  }
}

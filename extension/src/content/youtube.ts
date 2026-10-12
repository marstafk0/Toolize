import { looksLikeBot } from '../shared/feeds';
import type { Settings } from '../shared/settings';

/**
 * Protection from the porn-spam bots in YouTube comments. They lure with a sexual
 * avatar and "look at my profile", and churn faster than any blocklist, so: no
 * commenter avatars, no clicking through to a commenter, and comments that read like
 * that spam are removed. (Hiding comments altogether is the `youtube.comments` feed
 * toggle.) On while protection is on.
 */

const BOT_ATTR = 'data-tz-bot';
const COMMENT = ':is(ytd-comment-view-model, ytd-comment-renderer)';

const CSS = `
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
  private on = false;
  private seen = new WeakMap<Element, string>();
  private timer = 0;

  constructor() {
    this.style.dataset.toolize = 'youtube';
    this.style.textContent = CSS;
  }

  start(): void {
    this.timer = setInterval(() => this.update(), 300);
  }

  stop(): void {
    clearInterval(this.timer);
    this.style.remove();
  }

  setSettings(settings: Settings): void {
    this.on = settings.enabled;
    this.update();
  }

  private update(): void {
    if (!this.on) {
      this.style.remove();
      for (const el of document.querySelectorAll(`[${BOT_ATTR}]`)) el.removeAttribute(BOT_ATTR);
      this.seen = new WeakMap(); // rescan everything when turned back on
      return;
    }
    if (!this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
    this.scanForBots();
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
      target.toggleAttribute(BOT_ATTR, looksLikeBot(author, text));
    }
  }
}

import type { Settings } from '../shared/settings';
import { buildMatcher, DEFAULT_WORDS, matchesWords, urlAsText } from '../shared/words';

/**
 * The word filter in a page (top frame). Anywhere: an address or title with a blocked
 * word sends the tab to the blocked page — that covers searches, whose words are in the
 * address. On YouTube it also hides every video, Short, playlist and channel whose
 * title or channel name matches, and blocks a matching video's watch page.
 */

const YT_TILES = [
  'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer',
  'ytd-playlist-renderer', 'ytd-compact-playlist-renderer', 'ytd-radio-renderer', 'ytd-compact-radio-renderer',
  'ytd-channel-renderer', 'ytd-movie-renderer', 'ytd-reel-item-renderer', 'ytd-playlist-panel-video-renderer',
  'yt-lockup-view-model', 'ytm-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model-v2',
].join(',');
const HIDDEN_ATTR = 'data-tz-words';

export class WordFilter {
  private readonly style = document.createElement('style');
  private re: RegExp | null = null;
  private last = '';
  private timer = 0;
  private readonly youtube: boolean;
  private seen = new WeakMap<Element, string>();

  constructor(private readonly onBlocked: () => void) {
    this.youtube = /(^|\.)youtube\.com$/.test(location.hostname) || (__DEV__ && location.hostname === 'youtube.test');
    this.style.dataset.toolize = 'words';
    this.style.textContent = `[${HIDDEN_ATTR}] { display: none !important; }`;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), 300);
  }

  stop(): void {
    clearInterval(this.timer);
    this.style.remove();
  }

  setSettings(s: Settings): void {
    this.re = s.enabled && s.wordFilter ? buildMatcher([...DEFAULT_WORDS, ...(s.blockedWords ?? [])]) : null;
    this.last = '';
    if (!this.re) {
      this.style.remove();
      for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
    }
    this.seen = new WeakMap(); // a different list changes every answer
    this.check();
  }

  private check(): void {
    if (!this.re) return;
    const page = `${location.href}\n${document.title}`;
    if (page !== this.last) {
      this.last = page;
      if (matchesWords(this.re, urlAsText(location.href)) || matchesWords(this.re, document.title)) {
        this.onBlocked();
        return;
      }
    }
    if (!this.youtube) return;
    if (!this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
    this.checkWatchPage();
    this.hideTiles();
  }

  /** The title in the page, not document.title, which lags behind in-app navigation. */
  private checkWatchPage(): void {
    if (location.pathname !== '/watch') return;
    const meta = document.querySelector('ytd-watch-metadata');
    const info = [meta?.querySelector('h1')?.textContent, meta?.querySelector('#owner #channel-name')?.textContent].join(' ');
    if (matchesWords(this.re, info)) this.onBlocked();
  }

  private hideTiles(): void {
    for (const el of document.querySelectorAll(YT_TILES)) {
      const parts: (string | null | undefined)[] = [el.querySelector('#video-title, h3, [title]')?.textContent];
      for (const n of el.querySelectorAll('[title], [aria-label], #channel-name, a[href^="/@"]')) {
        parts.push(n.getAttribute('title'), n.getAttribute('aria-label'), n.textContent);
      }
      const text = parts.filter(Boolean).join(' ');
      if (this.seen.get(el) === text) continue; // tiles are recycled with new content
      this.seen.set(el, text);
      el.toggleAttribute(HIDDEN_ATTR, matchesWords(this.re, text));
    }
  }
}

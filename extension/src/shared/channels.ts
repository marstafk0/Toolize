/**
 * Trusted YouTube channels: their videos, Shorts and thumbnails skip the image check.
 * For channels the model reliably misjudges — raw meat close-ups score as porn (0.95 on
 * butchery Shorts) — where no threshold separates them from the real thing. Adding a
 * channel is a weakening change (the key); the word filter still applies to them.
 */

/** "Max the Meat Guy", "@MaxTheMeatGuy" and "maxthemeatguy" are the same channel. */
export function channelKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function isYouTube(hostname: string): boolean {
  return /(^|\.)youtube\.com$/.test(hostname) || (__DEV__ && hostname === 'youtube.test');
}

export function trustedSet(channels: readonly string[] | undefined): Set<string> {
  return new Set((channels ?? []).map(channelKey).filter(Boolean));
}

/** Tiles in YouTube's lists that show a channel next to a thumbnail. */
const TILE = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytd-playlist-panel-video-renderer';

/** The channel of the YouTube list tile an element sits in, by its /@handle link or name. */
export function tileChannels(el: Element): string[] {
  const tile = el.closest(TILE);
  if (!tile) return [];
  const names: string[] = [];
  for (const a of tile.querySelectorAll('a[href^="/@"]')) names.push(a.getAttribute('href')!.slice(2).split('/')[0]);
  for (const n of tile.querySelectorAll('#channel-name, ytd-channel-name')) names.push(n.textContent ?? '');
  return names;
}

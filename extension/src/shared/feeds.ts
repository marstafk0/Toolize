import facebook from '../../sites/facebook.json';
import youtube from '../../sites/youtube.json';

/**
 * Feed control: per-site distraction toggles. Each toggle is a named CSS ruleset in
 * sites/*.json, so a new site or a YouTube redesign is a data change, not code. The
 * desktop app embeds the same files to draw its checkboxes.
 */

export interface FeedToggle {
  id: string;
  label: string;
  hint: string;
  /** Only on paths (pathname + search) matching this regex. Default: everywhere. */
  paths?: string;
  /** Selectors hidden with display:none while the toggle is on. */
  hide: string[];
  /** A line of text shown in place of what was hidden. */
  notice?: { at: string; text: string };
  /** Navigating to a matching path (pathname + search) goes here instead. */
  redirect?: { from: string; to: string };
}

export interface FeedSite {
  id: string;
  name: string;
  /** Matched with their subdomains. */
  hosts: string[];
  toggles: FeedToggle[];
}

export const CATALOG: FeedSite[] = [youtube, facebook];

/** Settings key for a toggle, e.g. "youtube.home". */
export const feedKey = (site: FeedSite, toggle: FeedToggle): string => `${site.id}.${toggle.id}`;

export function siteForHost(hostname: string): FeedSite | undefined {
  return CATALOG.find(
    (s) =>
      s.hosts.some((d) => hostname === d || hostname.endsWith(`.${d}`)) ||
      // Dev builds also answer on <site>.test, which e2e maps to the test server.
      (__DEV__ && hostname === `${s.id}.test`),
  );
}

// ---------------------------------------------------------------- comment bots

/**
 * Spam bots in big channels' comments: a sexual avatar and a handle or text that says
 * "look at my profile", which leads to a porn link. They are deleted and replaced too
 * fast for any blocklist. Avatars are hidden and profile links made unclickable for
 * every comment (content/youtube.ts); this catches the comments themselves.
 */

// Letters from other scripts that look Latin, used to dodge word filters.
const CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', ԁ: 'd', һ: 'h',
  ո: 'n', ս: 'u', ɡ: 'g', α: 'a', ο: 'o', ν: 'v', τ: 't', ρ: 'p', κ: 'k', ι: 'i', ʏ: 'y', ᴏ: 'o',
};
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Lowercase, fancy-font letters folded (𝓢𝓮𝔁𝔂 → sexy), accents and invisible characters gone. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\p{M}​-‏⁠﻿]/gu, '')
    .toLowerCase()
    .replace(/./gu, (c) => CONFUSABLES[c] ?? c);
}

/** Letters only, digits read as letters: "o.n.l.y f4ns" → "onlyfans". */
const squash = (s: string): string => s.replace(/./gu, (c) => LEET[c] ?? c).replace(/[^a-z]/g, '');

const BOT_EMOJI_NAME = /[🔞💋🍑🍆💦👅🥵🫦]/u;
const BOT_EMOJI_TEXT = /[🔞🫦]/u;
const SEXUAL_WORDS = /\b(porn\w*|xxx+|nsfw|nudes?|naked|onlyfans|only ?fans|hentai|horny|sexy|sex|hookups?|fuck\w*|dating|lonely (girls?|women)|hot (girls?|women|wife|moms?))\b|\b18 ?\+/;
// Comment text is held to a narrower list than handles: people swear, and say "sexy car".
const TEXT_WORDS = /\b(porn\w*|xxx+|nudes|onlyfans|only ?fans|hentai|horny|hookups?|sex ?chat)\b|\b18 ?\+/;
const SQUASHED_WORDS = /onlyfans|porn|hentai|horny|nudes|xxx/;
const SOLICIT = /\b(my|on my|check my|see my|visit my|click my|tap my|look at my|open my) (profile|channel|page|bio|avatar|pfp|photos?|pics?|picture)\b/;

export function looksLikeBot(author: string, text: string): boolean {
  if (BOT_EMOJI_NAME.test(author) || BOT_EMOJI_TEXT.test(text)) return true;
  const a = normalize(author);
  const t = normalize(text);
  return SEXUAL_WORDS.test(a) || SQUASHED_WORDS.test(squash(a)) || SOLICIT.test(t) || TEXT_WORDS.test(t);
}

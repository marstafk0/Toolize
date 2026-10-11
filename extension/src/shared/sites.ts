import DOMAINS from './adult-domains.json';

/**
 * Site-level blocking. Cheaper and more reliable than classifying thousands of images:
 * a known adult site never loads at all. This hand-kept seed list is merged at build
 * time with the OISD NSFW list (scripts/blocklist.mjs, ~470k domains), which the
 * extension also refreshes daily. The classifier remains the backstop for everything
 * the lists miss, and sites it catches repeatedly are learned (background/blocklist.ts).
 */
export const ADULT_DOMAINS: string[] = DOMAINS;

/**
 * Never blocked by a list, whatever a downloaded list says. Exact matches only:
 * "nsfw.reddit.com" on a list still blocks that subdomain, but "reddit.com" itself can
 * never be blocked by a list update gone wrong.
 */
export const NEVER_BLOCK = [
  'google.com', 'youtube.com', 'ytimg.com', 'googlevideo.com', 'googleusercontent.com', 'gstatic.com',
  'bing.com', 'bing.net', 'duckduckgo.com', 'yahoo.com', 'microsoft.com', 'live.com', 'office.com',
  'reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com',
  'twitter.com', 'x.com', 'twimg.com', 't.co',
  'facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'whatsapp.com', 'messenger.com',
  'tiktok.com', 'pinterest.com', 'tumblr.com', 'imgur.com', 'discord.com', 'discordapp.com', 'discordapp.net',
  'telegram.org', 't.me', 'twitch.tv', 'kick.com', 'rumble.com', 'vimeo.com',
  'wikipedia.org', 'wikimedia.org', 'archive.org', 'github.com', 'githubusercontent.com',
  'amazon.com', 'amazonaws.com', 'cloudfront.net', 'akamaized.net', 'akamaihd.net', 'cloudflare.com',
  'jsdelivr.net', 'unpkg.com', 'apple.com', 'icloud.com', 'netflix.com', 'spotify.com',
  'medium.com', 'substack.com', 'blogspot.com', 'wordpress.com', 'patreon.com', 'deviantart.com', 'pixiv.net',
];

/**
 * Never learned from flagged images (see blocklist.ts): platforms whose content comes
 * from millions of users, where one page of explicit posts says nothing about the rest.
 * Per-image blur still applies on them, and lists can still block their adult
 * subdomains. Matched with subdomains.
 */
export const NO_LEARN = [
  ...NEVER_BLOCK,
  'yandex.com', 'yandex.ru', 'baidu.com', 'ecosia.org', 'startpage.com', 'brave.com',
  'vk.com', 'ok.ru', 'bilibili.com', 'weibo.com', 'threads.net', 'bsky.app', 'mastodon.social',
  'flickr.com', 'artstation.com', '9gag.com', 'giphy.com', 'tenor.com', 'ebay.com', 'etsy.com',
  'quora.com', 'fandom.com', 'snapchat.com', 'linkedin.com', 'dailymotion.com',
];

/**
 * The registrable part of a hostname, near enough: the last two labels, or three under
 * common second-level suffixes (example.co.uk). Learning blocks this and its subdomains.
 */
export function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const sld = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const compound = tld.length === 2 && ['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go'].includes(sld);
  return labels.slice(compound ? -3 : -2).join('.');
}

/** Whether flagged images on this host may get the whole site blocked. */
export function canLearn(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // Not real sites (and the e2e server lives here, with plenty of flagged images).
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return false;
  return !NO_LEARN.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Hostname keyword heuristic for the long tail, in two tiers.
 *
 * STRONG words are unambiguous, so they match anywhere in the hostname
 * ("freeporn-tube.net", "myxxxsite.com").
 */
export const STRONG_WORDS = [
  'porn',
  'xxx',
  'hentai',
  'nsfw',
  'milf',
  'bdsm',
  'camgirl',
  'blowjob',
  'creampie',
  'rule34',
  'camwhore',
  'escort',
];

/**
 * WEAK words appear inside ordinary English, so they only match a whole hostname label:
 * "analytics.google.com" and "sussex.ac.uk" must not trip "anal" or "sex".
 */
export const WEAK_WORDS = ['sex', 'sexo', 'nude', 'nudes', 'boobs', 'fetish', 'anal', 'incest', 'tits'];

/** Labels that are a weak word plus context, and are legitimate. */
const ALLOW_LABELS = ['sexuality', 'sexualhealth', 'sexeducation', 'middlesex', 'sussex', 'essex', 'wessex', 'sexton'];

export function isAdultHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (ADULT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  const labels = host.split(/[.\-_]/);
  if (labels.some((l) => ALLOW_LABELS.includes(l))) return false;
  if (STRONG_WORDS.some((w) => host.includes(w))) return true;
  return labels.some((l) => WEAK_WORDS.includes(l));
}

/** Regex source for the declarativeNetRequest keyword rule (matches the tiers above). */
export function adultHostRegex(): string {
  const host = '[^/]*';
  const strong = `^https?://${host}(${STRONG_WORDS.join('|')})${host}(/|$)`;
  const weak = `^https?://([^/]*[.\\-_])?(${WEAK_WORDS.join('|')})([.\\-_][^/]*)?\\.[a-z]{2,}(/|$)`;
  return `(${strong})|(${weak})`;
}

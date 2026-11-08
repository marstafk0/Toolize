import { normalize, squash } from './feeds';

/**
 * Word filter: pages whose address or title contains a blocked word are blocked, and
 * YouTube videos whose title or channel does are hidden. It catches what images can't
 * show yet (a search, a "nude photography" video before it plays) and what the model is
 * lenient about. Matching is whole-word and case-insensitive ("sex" doesn't hit
 * "Essex"), after folding fancy Unicode fonts and lookalike letters. An entry written
 * as /regex/ is used as a pattern.
 */
export const DEFAULT_WORDS: readonly string[] = [
  // explicit
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', '18+', 'onlyfans', 'only fans', 'fansly', 'hentai',
  'rule34', 'rule 34', 'nude', 'nudes', 'nudity', 'naked', 'topless', 'sex', 'sexual', 'erotic', 'erotica',
  'lewd', 'uncensored', 'playboy', 'camgirl', 'cam girl', 'stripper', 'striptease', 'strip club', 'lap dance',
  'pron', 'lewds', 'smut', 'softcore', 'porn star', 'pornstar', 'adult film', 'adult video', 'xxx video',
  'sex video', 'sex scene', 'nude scene', 'topless scene', 'hardcore porn',
  // sexual acts and anatomy (ordinary words such as "ass" and "facial" are omitted)
  'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang', 'threesome', 'orgy', 'anal', 'deepthroat',
  'bukkake', 'facesitting', 'pegging', 'cum', 'jizz', '/masturbat\\w*/', '/jerk(ing)?[\\s_-]+off/',
  'orgasm', 'horny', 'slut', 'whore', 'pussy', 'cock', 'dick pic', 'tits', 'titties', 'boobies',
  'big tits', '/nipples?/', '/areolas?/', 'milf',
  // industry and adult sites
  'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'youporn', 'spankbang', 'brazzers', 'bangbros',
  'chaturbate', 'stripchat', 'camsoda', 'livejasmin', 'onlyfans leak', 'fapello', 'thothub', 'gonewild',
  'nhentai', 'e-hentai', 'hanime', 'fakku', 'gelbooru', 'danbooru', 'rule34xxx', 'e621', 'yiff',
  // anime / hentai (not "yuri" or "tentacle" alone)
  'ecchi', 'doujin', 'doujinshi', 'ahegao', 'futanari', 'futa', 'oppai', 'paizuri', 'bakunyuu',
  'netorare', 'ntr', 'lolicon', 'loli', 'shotacon', 'shota', 'yaoi', 'r18', 'r-18', 'r34',
  // kink and voyeurism
  'bdsm', 'bondage', 'shibari', 'femdom', 'dominatrix', 'fetish', 'foot fetish', 'upskirt', 'downblouse',
  'nip slip', 'nipslip', 'wardrobe malfunction', 'voyeur', 'sextape', 'sex tape', 'leaked nudes',
  'nudist', 'nudism', 'jav', 'gravure idol', 'sex toy', 'dildo', 'vibrator', 'fleshlight', 'butt plug',
  'strapon', 'strap-on',
  // escort / prostitution
  'escort', 'escorts', 'hooker', 'prostitute', 'brothel', 'sugar baby',
  // common leetspeak: normalize() deliberately preserves digits and punctuation
  '/p[o0]rn\\w*|pr[o0]n/', '/h[3e]nt[a4]i/', '/s[3e]x/',
  // revealing
  'sexy', 'seductive', 'sensual', 'lingerie', 'boudoir', 'braless', 'no bra', 'see through', 'see-through',
  'cleavage', 'boobs', 'thirst trap', 'twerk', 'twerking', 'body paint', 'bodypaint',
  // swimwear, without SpongeBob's Bikini Bottom
  '/bikinis?(?!\\s+bottom)/', 'micro bikini', 'try on haul', 'try-on haul', 'swimsuit try on',
  // scenes
  'hot girls', 'kiss scene', 'kissing scene', 'bed scene', 'steamy',
];

/** Substrings ONLY in extracted queries, never in a hostname, whole URL or title.
 * Leave out sex, anal, cum, ass and tit: they occur in everyday words. */
export const STRONG_QUERY_WORDS: readonly string[] = [
  'porn', 'pron', 'hentai', 'xxx', 'nsfw', 'rule34', 'r34', 'nude', 'nudes', 'naked',
  'boobs', 'tits', 'titties', 'boobies', 'pussy', 'blowjob', 'handjob', 'creampie', 'cumshot', 'milf',
  'onlyfans', 'ahegao', 'futanari', 'doujin', 'ecchi', 'gangbang', 'bdsm', 'lewd', 'hooker', 'dildo',
  'nhentai', 'xvideos', 'pornhub', 'xnxx', 'xhamster', 'brazzers', 'chaturbate', 'yiff', 'e621',
  'lolicon', 'shotacon', 'paizuri', 'bakunyuu', 'bukkake', 'deepthroat', 'spankbang', 'redtube',
  'youporn', 'bangbros', 'fapello', 'thothub', 'gelbooru', 'danbooru', 'femdom', 'fleshlight',
];

// Numeric names must be checked before lossy leet folding: r34 -> rea would block
// "reading", and e621 -> ei would block "their". Still ignore spaces/punctuation.
const STRONG_NUMERIC = STRONG_QUERY_WORDS.filter((word) => /\d/.test(word));
const STRONG_SQUASHED = [...new Set(STRONG_QUERY_WORDS.filter((word) => !/\d/.test(word)).map(squash))];

export function matchesStrongQuery(text: string): boolean {
  const query = squash(text);
  const numeric = normalize(text).replace(/[^a-z0-9]/g, '');
  return STRONG_SQUASHED.some((word) => query.includes(word)) || STRONG_NUMERIC.some((word) => numeric.includes(word));
}

const LETTER = '[\\p{L}\\p{N}]';

function toSource(entry: string): string | null {
  const e = entry.trim();
  if (!e || e.startsWith('#')) return null;
  const body =
    e.length > 2 && e.startsWith('/') && e.endsWith('/')
      ? e.slice(1, -1)
      : normalize(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s_-]+');
  // Whole words: not glued to a letter or digit on either side.
  return `(?<!${LETTER})(?:${body})(?!${LETTER})`;
}

export function buildMatcher(entries: readonly string[]): RegExp | null {
  const sources: string[] = [];
  for (const e of entries) {
    const s = toSource(e);
    if (!s) continue;
    try {
      new RegExp(s, 'u'); // a broken /regex/ from the user is skipped, not fatal
      sources.push(s);
    } catch {
      /* ignore */
    }
  }
  return sources.length ? new RegExp(sources.join('|'), 'iu') : null;
}

export function matchesWords(re: RegExp | null, text: string | null | undefined): boolean {
  return !!re && !!text && re.test(normalize(text));
}

/** An address as words: decoded, with its punctuation read as spaces ("/nude-art?q=x" → "nude art q x"). */
export function urlAsText(href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href.replace(/\+/g, ' '));
  } catch {
    /* keep it raw */
  }
  return decoded.replace(/[/?#&=.:_%]+/g, ' ');
}

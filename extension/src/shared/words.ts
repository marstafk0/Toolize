import { normalize, squash } from './feeds';

// Exceptions belong to built-in patterns, so a user's literal extra still blocks.
// Separators also cover decoded URL paths. Each exception applies to this occurrence.
function contextWord(body: string, before = '', after = ''): string {
  return `/${before ? `(?<!\\b(?:${before})[\\s_-]+)` : ''}(?:${body})${after ? `(?![\\s_-]+(?:${after})\\b)` : ''}/`;
}

const NUDE = contextWord('nudes?', 'matisse(?:[\\s_-]+blue)?|duchamp',
  'lipstick|nail(?:[\\s_-]+polish)?|heels|shoes|palette|matisse|duchamp|descending[\\s_-]+a[\\s_-]+staircase');
const NAKED = contextWord('naked', '', 'eye|mole|cake|smoothie|short|put|call|seed|juice|gun|and[\\s_-]+not[\\s_-]+ashamed');
const TITS = contextWord('tits', 'blue|great|coal|crested|marsh|willow|long[\\s_-]+tailed');
const PUSSY = contextWord('pussy', '', 'willows?|cats?|toes?');
const XXX = contextWord('xxx', 'super[\\s_-]+bowl|wrestlemania', 'olympiad');
const DILDO = contextWord('dildos?', '', 'island|newfoundland');
const R34 = contextWord('r[-_]?34', 'gt[-_]?r|skyline|nissan', 'skyline|gt[-_]?r|v[\\s_-]+spec');
const R18 = contextWord('r[-_]?18', 'audi|bmw|honda(?:[\\s_-]+civic)?|insulation', 'insulation|engine|motorcycle|e[\\s_-]+tron');
const E621 = contextWord('e[-_]?621', 'monosodium[\\s_-]+glutamate|food[\\s_-]+additive|additive', 'additive|monosodium|glutamate');

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
  'porn', 'porno', 'pornography', XXX, 'nsfw', '/18\\+(?![\\s_-]*\\d)/', 'onlyfans', 'only fans', 'fansly', 'hentai',
  'rule34', 'rule 34', NUDE, 'nudity', NAKED, 'topless',
  contextWord('s[3e]x', 'biological|assigned|chromosomal|canon(?:[\\s_-]+powershot)?|powershot', 'chromosomes?|linked|determination|dimorphism|differences?|ratio|education'),
  contextWord('sexual', '', 'reproduction|dimorphism|selection|development|health|orientation'), 'erotic', 'erotica',
  'lewd', 'uncensored', contextWord('playboy', '', 'of[\\s_-]+the[\\s_-]+western[\\s_-]+world'),
  'camgirl', 'cam girl', contextWord('strippers?', 'wire|paint|wax|floor|wallpaper|cable|varnish'), 'striptease', 'strip club', 'lap dance',
  'pron', 'lewds', contextWord('smut', 'corn', 'fungus|fungi|huitlacoche'), 'softcore', 'porn star', 'pornstar', 'adult film', 'adult video', 'xxx video',
  'sex video', 'sex scene', 'nude scene', 'topless scene', 'hardcore porn',
  // sexual acts and anatomy (ordinary words such as "ass" and "facial" are omitted)
  'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang', contextWord('threesome', 'golf'),
  contextWord('orgy', 'roman|historical'), contextWord('anal', '', 'fissures?|fistulas?|glands?|cancer|sphincter'), 'deepthroat',
  'bukkake', 'facesitting', 'pegging', '/cum(?![\\s_-]+laude)/', 'jizz', '/masturbat\\w*/', '/jerk(ing)?[\\s_-]+off/',
  'orgasm', contextWord('horny', '', 'goat|toad'), 'slut', contextWord('whore', '', 'of[\\s_-]+babylon'), PUSSY, 'cock', 'dick pic', TITS, 'titties', 'boobies',
  'big tits',
  contextWord('nipples?', 'baby[\\s_-]+bottle|grease|pipe|spoke|cracked|sore|breastfeeding(?:[\\s_-]+sore)?|inverted',
    '(?:[\\w-]+[\\s_-]+){0,4}(?:breastfeeding|nursing|newborn|latch|fitting|wrench|baby[\\s_-]+bottle)'),
  contextWord('areolas?', '', '(?:[\\w-]+[\\s_-]+){0,4}(?:pregnancy|pregnant|breastfeeding|glands)'), '/milfs?/',
  // industry and adult sites
  'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'youporn', 'spankbang', 'brazzers', 'bangbros',
  'chaturbate', 'stripchat', 'camsoda', 'livejasmin', 'onlyfans leak', 'fapello', 'thothub', 'gonewild',
  'nhentai', 'e-hentai', 'hanime', 'fakku', 'gelbooru', 'danbooru', 'rule34xxx', E621, 'yiff',
  // anime / hentai (not "yuri" or "tentacle" alone)
  'ecchi', 'doujin', 'doujinshi', 'ahegao', 'futanari', contextWord('futa', '', 'tax|credit|rate'), 'oppai', 'paizuri', 'bakunyuu',
  'netorare', contextWord('ntr', 'jr'), 'lolicon', 'loli', 'shotacon', contextWord('shota', '', 'imanaga|rustaveli'), 'yaoi', R18, R34,
  // kink and voyeurism
  'bdsm', contextWord('bondage', 'human|debt|exodus|luther|maugham', 'of[\\s_-]+the[\\s_-]+will|in[\\s_-]+egypt|exodus|luther|maugham'),
  'shibari', 'femdom', 'dominatrix', 'fetish', 'foot fetish', 'upskirt', 'downblouse',
  'nip slip', 'nipple slip', 'nipslip', 'wardrobe malfunction', 'voyeur', 'sextape', 'sex tape', 'leaked nudes',
  'nudist', 'nudism', 'jav', 'gravure idol', 'sex toy', DILDO, contextWord('vibrators?', 'concrete|ultrasonic|industrial'), 'fleshlight', 'butt plug',
  'strapon', 'strap-on',
  // escort / prostitution
  contextWord('escorts?', 'ford|police|naval(?:[\\s_-]+destroyer)?|military|funeral', 'radar|detector'),
  // Hooker is usually a surname, occupation or brand; require a sexual phrase.
  '/hookers?(?=[\\s_-]+(?:porn|sex|videos?|escort|service)\\b)/', '/(?:hot|hire)[\\s_-]+hookers?/',
  'prostitute', 'brothel', contextWord('sugar[\\s_-]+baby', '', 'watermelon'),
  // common leetspeak: normalize() deliberately preserves digits and punctuation
  '/p[o0]rn\\w*|pr[o0]n/', '/h[3e]nt[a4]i/',
  // revealing
  'sexy', 'seductive', 'sensual', 'lingerie', 'boudoir', 'braless', 'no bra',
  'see through lingerie', 'see through dress', 'see through shirt',
  contextWord('cleavage', 'mineral|cell|oxidative|proteolytic|basal|slaty|rock', 'planes?|fracture|embryology'),
  'boobs', 'thirst trap', 'twerk', 'twerking', contextWord('body[\\s_-]*paint', 'auto|car|automotive|vehicle'),
  // swimwear, without SpongeBob's Bikini Bottom
  '/bikinis?(?![\\s_-]+(?:bottom|atoll))/', 'micro bikini', 'try on haul', 'try-on haul', 'swimsuit try on',
  // Generic steam, seeing-through, and bed/kiss film scenes have everyday uses.
  'hot girls',
];

/** Substrings ONLY in extracted queries, never in a hostname, whole URL or title.
 * Leave out sex, anal, cum, ass and tit: they occur in everyday words. */
export const STRONG_QUERY_WORDS: readonly string[] = [
  // not "pron": it sits inside "pronounce" and "pronoun" (it stays a whole word above)
  'porn', 'hentai', 'nsfw',
  'boobs', 'titties', 'boobies', 'blowjob', 'handjob', 'creampie', 'cumshot',
  'onlyfans', 'ahegao', 'futanari', 'doujin', 'gangbang', 'bdsm', 'lewd',
  'nhentai', 'xvideos', 'pornhub', 'xnxx', 'xhamster', 'brazzers', 'chaturbate', 'yiff',
  'lolicon', 'shotacon', 'paizuri', 'bakunyuu', 'bukkake', 'deepthroat', 'spankbang', 'redtube',
  'youporn', 'bangbros', 'fapello', 'thothub', 'gelbooru', 'danbooru', 'femdom', 'fleshlight',
];

// Dictionary collisions demote nude(s), naked, tits, pussy, milf and ecchi to whole
// words; xxx/dildo/hooker need context too. Keep explicitly sexual compounds.
const SEXUAL_COMPOUND = /(?:(?:big|huge|hot|sexy|bare|naked)tits|(?:free|hot|sexy|leaked)(?:nudes?|naked|milf|pussy|ecchi)|(?:nudes?|naked|milf|pussy|ecchi|xxx)(?:leak|girl|pic|photo|video|porn|sex|hunter|seeker))\w*$/;
const STRONG_SQUASHED = STRONG_QUERY_WORDS.map(squash);

function queryText(text: string): string {
  return normalize(text)
    // Only >=3 isolated characters are joined, never ordinary adjacent words.
    .replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][^\p{L}\p{N}]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu,
      (run) => run.replace(/[^\p{L}\p{N}]/gu, ''))
    .replace(/[^\p{L}\p{N}\s_+-]/gu, ' ')
    // Query prose treats underscores as separators; URL ID values keep them below.
    .replace(/_/g, '-')
    .replace(/[\p{L}\p{N}]+/gu, (token) => {
      // Pure numbers stay numbers; numeric names are matched before lossy folding.
      if (!/\p{L}/u.test(token) || /^(?:r18|r34|e621|rule34)$/.test(token)) return token;
      return token.replace(/[013457]/g, squash);
    });
}

export function matchesStrongQuery(text: string): boolean {
  const query = queryText(text);
  if (matchesWords(QUERY_WORDS, query)) return true;
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).some((token) =>
    /\p{L}/u.test(token) && (STRONG_SQUASHED.some((word) => token.includes(word)) || SEXUAL_COMPOUND.test(token)));
}

const LETTER = '[\\p{L}\\p{N}_]';

function toSource(entry: string): string | null {
  const e = entry.trim();
  if (!e || e.startsWith('#')) return null;
  const body =
    e.length > 2 && e.startsWith('/') && e.endsWith('/')
      ? e.slice(1, -1)
      : normalize(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s_-]+');
  // Whole words: underscores stay part of identifiers in query values/titles.
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

const QUERY_WORDS = buildMatcher(DEFAULT_WORDS);

const OPAQUE_PARAMS = /^(?:v|vi|id|.*_id|si|t|list|index|feature|token|.*_token|sig|signature|key|api_key|hash|nonce|session|sessionid|auth|code|fbclid|gclid|utm_.*)$/i;

function addressWords(text: string): string {
  try {
    text = decodeURIComponent(text);
  } catch {
    // A malformed escape in one component must not reintroduce opaque parameters.
  }
  return text.replace(/[/?#&=.:_%+-]+/g, ' ');
}

/** Decode address words while skipping opaque IDs and preserving value underscores. */
export function urlAsText(href: string): string {
  try {
    const url = new URL(href);
    const path = addressWords(`${url.hostname}${url.pathname}`);
    // Values keep underscores: abc_sex_123 is an identifier, not prose.
    const values = [...url.searchParams].filter(([key]) => !OPAQUE_PARAMS.test(key)).map(([, value]) => value);
    const fragment = addressWords(url.hash.slice(1));
    return [path, ...values, fragment].join(' ');
  } catch {
    return href;
  }
}

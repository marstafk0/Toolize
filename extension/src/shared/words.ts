import { normalize } from './feeds';

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
  // revealing
  'sexy', 'seductive', 'sensual', 'lingerie', 'boudoir', 'braless', 'no bra', 'see through', 'see-through',
  'cleavage', 'boobs', 'thirst trap', 'twerk', 'twerking', 'body paint', 'bodypaint',
  // swimwear, without SpongeBob's Bikini Bottom
  '/bikinis?(?!\\s+bottom)/', 'micro bikini', 'try on haul', 'try-on haul', 'swimsuit try on',
  // scenes
  'hot girls', 'kiss scene', 'kissing scene', 'bed scene', 'steamy',
];

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

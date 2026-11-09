// Explicit-query recall, paired with the independent 310-query clean corpus.
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_BLOCKED_QUERIES = [
  // Plain terms, acts, anatomy and sites.
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', '18+ videos', 'onlyfans', 'only fans', 'fansly',
  'hentai', 'nude', 'nudes', 'nudity', 'naked', 'topless', 'sex', 'sexual', 'erotic', 'erotica',
  'lewd', 'uncensored porn', 'playboy magazine', 'camgirl', 'cam girl', 'stripper dancing',
  'striptease', 'strip club', 'lap dance', 'pron', 'lewds', 'smut', 'softcore', 'porn star',
  'pornstar', 'adult film', 'adult video', 'xxx video', 'sex video', 'sex scene', 'nude scene',
  'topless scene', 'hardcore porn', 'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang',
  'threesome', 'orgy', 'anal', 'deepthroat', 'bukkake', 'facesitting', 'pegging', 'cum', 'jizz',
  'masturbation', 'masturbating', 'jerking off', 'jerk-off', 'orgasm', 'horny', 'slut', 'whore',
  'pussy', 'cock', 'dick pic', 'tits', 'titties', 'boobies', 'big tits', 'nipples', 'areola', 'milf',
  'pornhub', 'xvideos', 'xnxx', 'xhamster', 'redtube', 'youporn', 'spankbang', 'brazzers',
  'bangbros', 'chaturbate', 'stripchat', 'camsoda', 'livejasmin', 'onlyfans leak', 'fapello',
  'thothub', 'gonewild', 'nhentai', 'e-hentai', 'hanime', 'fakku', 'gelbooru', 'danbooru',
  'rule34xxx', 'e621', 'yiff',
  // Anime/hentai vocabulary and exact numeric names, including internal separators.
  'ecchi', 'doujin', 'doujinshi', 'ahegao', 'futanari', 'futa', 'oppai', 'paizuri', 'bakunyuu',
  'netorare', 'ntr', 'lolicon', 'loli', 'shotacon', 'shota', 'yaoi', 'r18', 'r-18', 'r_18',
  'r34', 'r-34', 'r_34', 'rule34', 'rule 34', 'rule-34', 'e-621', 'e_621',
  'bdsm', 'bondage', 'shibari', 'femdom', 'dominatrix', 'fetish', 'foot fetish', 'upskirt',
  'downblouse', 'nip slip', 'nipslip', 'nipple slip', 'wardrobe malfunction', 'voyeur', 'sextape',
  'sex tape', 'leaked nudes', 'nudist', 'nudism', 'jav', 'gravure idol', 'sex toy', 'dildo',
  'vibrator', 'fleshlight', 'butt plug', 'strapon', 'strap-on', 'escort service near me',
  'hooker porn', 'hot hooker', 'prostitute', 'brothel', 'sugar baby', 'sexy', 'seductive',
  'sensual', 'lingerie', 'boudoir', 'braless', 'no bra', 'see through lingerie', 'see-through dress',
  'cleavage', 'boobs', 'thirst trap', 'twerk', 'twerking', 'body paint', 'bodypaint', 'bikini',
  'micro bikini', 'try on haul', 'try-on haul', 'swimsuit try on', 'hot girls',
  // Leetspeak, Unicode, isolated characters and explicit concatenations.
  'p0rn', 'h3ntai', 's3x video', 's3x', 'pr0n', 'hent4i', 'p0rnhub', 'freep0rnvideos',
  'p o r n', 'p.o.r.n', 'p-o-r-n', 'h 3 n t a i', 'h.e.n.t.a.i', 'e 6 2 1 gallery',
  'r 3 4', 'n u d e pics', 't i t s', 'ｈｅｎｔａｉ', 'hеntаi', '𝓹𝓸𝓻𝓷',
  'freepornvideos', 'bigtitsgirls', 'hentaihaven', 'xvideoscom', 'pornhubpremium', 'nudesleaked',
  'bigboobs', 'hotmilf', 'milfhunter', 'ecchivideos', 'nakedgirls', 'freehentaigallery',
  'sex video', 'nude pics', 'naked girls', 'hot milf', 'cum tribute', 'only.f4ns', 'milfs', 'hot hookers', 'bestxxxvideos',
  // An ordinary context must not excuse a separate explicit occurrence.
  'naked eye naked girls', 'blue tits big tits', 'cum laude cum tribute',
  'Ford Escort escort service', 'mineral cleavage hentai', 'FUTA tax futa hentai',
];

export async function checkBlockedQueries(words) {
  const re = words.buildMatcher(words.DEFAULT_WORDS);
  const missed = EXPECTED_BLOCKED_QUERIES.filter((q) => !words.matchesWords(re, q) && !words.matchesStrongQuery(q));
  assert.ok(EXPECTED_BLOCKED_QUERIES.length >= 120);
  console.log(`Blocked ${EXPECTED_BLOCKED_QUERIES.length - missed.length}/${EXPECTED_BLOCKED_QUERIES.length} expected-explicit queries.`);
  assert.deepEqual(missed, [], 'explicit queries must be blocked');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = await esbuild.build({
    entryPoints: [join(root, 'src/shared/words.ts')], bundle: true, format: 'esm', write: false,
    define: { __DEV__: 'false' }, logLevel: 'silent',
  });
  const words = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  await checkBlockedQueries(words);
}
